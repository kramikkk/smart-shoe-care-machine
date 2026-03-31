import { NextRequest, NextResponse } from 'next/server'
import { GoogleGenAI } from '@google/genai'
import prisma from '@/lib/prisma'
import {
  broadcastClassificationResult,
  broadcastClassificationError,
} from '@/lib/websocket'
import { rateLimit } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

const MAX_IMAGE_SIZE = 10 * 1024 * 1024 // 10MB

const SHOE_TYPES = ['mesh', 'canvas', 'rubber', 'invalid', 'no_shoe']

const PROMPT = `Identify the PRIMARY upper material of the shoe. Ignore sole, laces, logo patches.

MESH — open-weave knit/synthetic upper; visible holes or perforations; light passes through the material
  (Nike Flyknit/Ultraboost, Adidas Primeknit, running shoes, breathable athletic trainers)

CANVAS — solid woven fabric upper; NO holes; matte; thread crossings visible like a cotton bag; non-stretchy
  (Converse Chuck Taylor, Vans Old Skool/Slip-On, TOMS, Keds, classic cloth low-tops and high-tops)

RUBBER — fully ENCLOSED smooth molded upper; featureless non-porous surface; looks like one-piece rubber/PVC; toe AND heel fully covered with NO holes in the upper
  (classic white rubber sneakers common in SE Asia/PH, rain boots, PVC closed-toe shoes)
  ⚠ Rubber sole alone does NOT make it rubber — the UPPER itself must be smooth, featureless, AND fully closed.
  ⚠ Crocs, EVA clogs, and ventilated rubber shoes are NOT rubber — classify as INVALID (see below).

INVALID — footwear present but NOT serviceable:
  • Wrong material: leather, suede, PU/synthetic leather, patent leather, nubuck, velvet, glossy/semi-gloss uppers
    (Air Force 1, Jordan 1, Nike Dunk, dress shoes, Oxford, loafers, dark leather sneakers, ladies low/high heels,
    ballet flats, stilettos, platform heels, cleats, school shoes with smooth leather-like upper)
  • Open or ventilated footwear — ANY shoe where toes OR heel are exposed, OR upper has deliberate holes/cutouts:
    Crocs (ALL types — rubber/EVA but INVALID), Havaianas, flip-flops, slippers, sandals, Birkenstock,
    mules, clogs, ventilated garden shoes, jelly shoes with holes

NO_SHOE — empty chamber, non-shoe object, or image too dark/blurry to identify
  EMPTY CHAMBER: bare transparent plastic shoe-tree holders with nothing stretched over them = no_shoe
  Do NOT classify holders, fans, tubes, or chamber walls as a shoe.

DISAMBIGUATION:
Mesh vs Canvas      — mesh has open holes/knit you can see through; canvas is solid opaque cloth with no holes
Canvas vs Rubber    — canvas has a visible woven thread grid; rubber is completely featureless smooth (no weave)
  Thread crossings visible → canvas | surface completely featureless AND fully enclosed → rubber
Canvas vs Invalid   — canvas is matte with visible weave; leather/PU is smooth, semi-gloss, or has grain/stitching
Rubber vs Invalid   — rubber UPPER must be fully enclosed (no holes, no exposed toe/heel); Crocs/EVA clogs look
  rubber but have holes or open design → INVALID; for dark-colored shoes: rubber is matte with zero stitching
  or grain on the upper panel; leather/PU shows grain texture, stitching seams, or a slight gloss → INVALID

CONDITION (mesh/canvas/rubber only; use "normal" for invalid/no_shoe):
normal    — dusty, scuffed, or lightly dirty; cleanable by foam + rotating brush
too_dirty — UPPER caked with thick mud, paint, tar, or oil requiring manual pre-treatment

Set confidence < 0.5 if image is dark, blurry, or upper is partially obscured. Never guess randomly.

Return JSON: { shoeType (mesh|canvas|rubber|invalid|no_shoe), confidence (0.0–1.0),
  subCategory ("2–5 word label" e.g. "White Canvas Low-tops", "Black Mesh Runners", "White Rubber Sneakers"; "" for no_shoe),
  condition (normal|too_dirty) }`

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! })

// Global Gemini RPM guard — free tier allows 30 RPM; cap at 25 to prevent paid-tier overflow.
// Module-level state persists across requests in the custom Node.js server process.
const GEMINI_MAX_RPM = 25
let geminiCallCount = 0
let geminiWindowStart = Date.now()

function acquireGeminiSlot(): boolean {
  const now = Date.now()
  if (now - geminiWindowStart >= 60_000) {
    geminiWindowStart = now
    geminiCallCount = 0
  }
  if (geminiCallCount >= GEMINI_MAX_RPM) return false
  geminiCallCount++
  return true
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> }
) {
  // Apply rate limiting (10 requests per minute per IP)
  const rateLimitResult = rateLimit(request, { maxRequests: 10, windowMs: 60000 })
  if (rateLimitResult) return rateLimitResult

  const { deviceId } = await params

  try {
    // Check image size before processing
    const contentLength = request.headers.get('content-length')
    if (contentLength && parseInt(contentLength) > MAX_IMAGE_SIZE) {
      return NextResponse.json(
        { error: 'Image too large. Maximum size is 10MB.' },
        { status: 413 }
      )
    }

    // Validate X-Group-Token header
    const groupToken = request.headers.get('X-Group-Token')
    if (!groupToken) {
      return NextResponse.json({ error: 'Missing X-Group-Token' }, { status: 401 })
    }

    // Look up device and verify token
    const device = await prisma.device.findUnique({
      where: { deviceId },
      select: { groupToken: true },
    })

    if (!device) {
      return NextResponse.json({ error: 'Device not found' }, { status: 404 })
    }

    if (!device.groupToken || device.groupToken !== groupToken) {
      return NextResponse.json({ error: 'Invalid group token' }, { status: 401 })
    }

    // Read raw JPEG bytes from request body
    const imageBuffer = Buffer.from(await request.arrayBuffer())
    if (imageBuffer.length === 0) {
      return NextResponse.json({ error: 'Empty image body' }, { status: 400 })
    }

    // Validate image size after reading
    if (imageBuffer.length > MAX_IMAGE_SIZE) {
      return NextResponse.json(
        { error: 'Image too large. Maximum size is 10MB.' },
        { status: 413 }
      )
    }

    // Guard: reject if over free-tier RPM limit to prevent paid-tier spillover
    if (!acquireGeminiSlot()) {
      console.warn(`[Classify] Gemini RPM limit reached — rejecting request for ${deviceId}`)
      return NextResponse.json({ error: 'Rate limit — retry shortly' }, { status: 429 })
    }

    // Encode once — reused for both Gemini and WebSocket broadcast
    const imageBase64 = imageBuffer.toString('base64')

    // Call Gemini with inline base64 JPEG
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-lite',
      contents: [
        {
          inlineData: {
            mimeType: 'image/jpeg',
            data: imageBase64,
          },
        },
        { text: PROMPT },
      ],
      config: {
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            shoeType:    { type: 'string' },
            confidence:  { type: 'number' },
            subCategory: { type: 'string' },
            condition:   { type: 'string' },
          },
          required: ['shoeType', 'confidence', 'subCategory', 'condition'],
        },
      },
    })

    const parsed = JSON.parse(response.text ?? '{}') as {
      shoeType?: string
      confidence?: number
      subCategory?: string
      condition?: string
    }

    const shoeType    = parsed.shoeType ?? ''
    const confidence  = typeof parsed.confidence === 'number' ? parsed.confidence : 0
    const subCategory = parsed.subCategory ?? ''
    const condition = (parsed.condition === 'too_dirty' ? 'too_dirty' : 'normal') as 'normal' | 'too_dirty'

    console.log(`[Classify] Gemini raw response for ${deviceId}:`, JSON.stringify(parsed))

    // Validate against allowlist
    if (!SHOE_TYPES.includes(shoeType)) {
      console.error(`[Classify] Unknown shoeType from Gemini: "${shoeType}" for ${deviceId}`)
      broadcastClassificationError(deviceId, 'Classification returned an unknown shoe type')
      return NextResponse.json({ error: 'Unknown shoe type' }, { status: 422 })
    }

    console.log(`[Classify] ${deviceId}: ${shoeType} — ${subCategory} (${(confidence * 100).toFixed(1)}%) — condition: ${condition}`)
    broadcastClassificationResult(deviceId, shoeType, confidence, subCategory, condition, imageBase64)

    return NextResponse.json({ ok: true, shoeType, confidence, subCategory, condition })
  } catch (error) {
    console.error('[Classify] Error:', error)
    broadcastClassificationError(deviceId, 'Classification failed — please try again')
    return NextResponse.json({ error: 'Classification failed' }, { status: 500 })
  }
}
