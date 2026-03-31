'use client'

import React, { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { ChevronRight, ArrowDown } from 'lucide-react'
import Image from 'next/image'
import { gsap, ScrollTrigger } from '@/lib/gsap'
import { motion, useScroll, useTransform, useSpring } from 'motion/react'

export default function HeroSection() {
    const containerRef = useRef<HTMLDivElement>(null)
    const imageWrapperRef = useRef<HTMLDivElement>(null)
    const introText1Ref = useRef<HTMLDivElement>(null)
    const introText2Ref = useRef<HTMLDivElement>(null)
    const contentRef = useRef<HTMLDivElement>(null)
    const startTextRef = useRef<HTMLDivElement>(null)

    const [mousePos, setMousePos] = useState({ x: 0, y: 0 })

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            setMousePos({
                x: e.clientX,
                y: e.clientY
            })
        }
        window.addEventListener('mousemove', handleMouseMove)
        return () => window.removeEventListener('mousemove', handleMouseMove)
    }, [])

    useEffect(() => {
        const mm = gsap.matchMedia()

        const buildTimeline = (isMobile: boolean) => {
            const d = (n: number) => isMobile ? n * 0.6 : n

            const ctx = gsap.context(() => {
                const tl = gsap.timeline({
                    scrollTrigger: {
                        trigger: containerRef.current,
                        start: 'top top',
                        end: isMobile ? '+=180%' : '+=250%',
                        pin: true,
                        scrub: isMobile ? true : 1.5,
                        anticipatePin: 1,
                    }
                })

                gsap.set(imageWrapperRef.current, { scale: 1.08, opacity: 1 })
                gsap.set([introText1Ref.current, introText2Ref.current], { opacity: 0, y: 150, scale: 0.5 })
                gsap.set(contentRef.current, { opacity: 0, y: 100 })
                gsap.set(startTextRef.current, { opacity: 1, y: 0, scale: 1 })

                tl.to(startTextRef.current, { opacity: 0, y: -100, scale: 1.2, duration: d(2), ease: "power2.inOut" })

                tl.to(introText1Ref.current, { opacity: 1, y: 0, scale: 1, z: 0, duration: d(1.5) }, `-=${d(0.5)}`)
                    .from(".reveal-text-1-mask", { clipPath: "inset(0 100% 0 0)", duration: d(1.5), ease: "expo.out" }, `-=${d(1.2)}`)
                    .from(".reveal-char-1", { yPercent: 120, rotationX: -45, opacity: 0, stagger: 0.03, duration: d(1.2), ease: "power4.out" }, `-=${d(1.2)}`)
                    .to(".parallax-bg-1", { y: -500, z: -1200, opacity: 0.15, duration: d(3), ease: "none" }, `-=${d(2)}`)
                    .to(".parallax-bg-2", { y: 250, z: 600, opacity: 0.3, duration: d(3), ease: "none" }, `-=${d(2)}`)
                    .to(introText1Ref.current, { opacity: 0, y: -250, z: 800, scale: 1.1, duration: d(1.5), ease: "power4.in" })

                tl.to(introText2Ref.current, { opacity: 1, y: 0, scale: 1, z: 0, duration: d(1.5) })
                    .from(".reveal-text-2-mask", { clipPath: "inset(0 0 0 100%)", duration: d(1.5), ease: "expo.out" }, `-=${d(1.2)}`)
                    .from(".reveal-char-2", { yPercent: -120, rotationX: 45, opacity: 0, stagger: 0.03, duration: d(1.2), ease: "power4.out" }, `-=${d(1.2)}`)
                    .to(".parallax-bg-3", { y: -600, z: -1500, opacity: 0.15, duration: d(3), ease: "none" }, `-=${d(2)}`)
                    .to(".parallax-bg-4", { y: 300, z: 800, opacity: 0.3, duration: d(3), ease: "none" }, `-=${d(2)}`)
                    .to(introText2Ref.current, { opacity: 0, y: -250, z: 1000, scale: 1.1, duration: d(1.5), ease: "power4.in" }, "+=0.3")

                tl.to(imageWrapperRef.current, { scale: 1, duration: d(25), ease: "none" }, 0)
                    .to(".hero-dim-overlay", { opacity: 0.6, duration: d(4), ease: "power2.inOut" }, `-=${d(4)}`)
                    .to(contentRef.current, { opacity: 1, y: 0, scale: 1, duration: d(3), ease: "power4.out" }, `-=${d(2)}`)
            }, containerRef)

            return ctx
        }

        mm.add('(max-width: 767px)', () => {
            const ctx = buildTimeline(true)
            return () => ctx.revert()
        })

        mm.add('(min-width: 768px)', () => {
            const ctx = buildTimeline(false)
            return () => ctx.revert()
        })

        return () => mm.revert()
    }, [])

    return (
        <div ref={containerRef} className="noise-overlay relative w-full h-screen bg-background overflow-hidden flex items-center justify-center perspective-premium">

            {/* Smaller Inverting Custom Cursor — desktop only */}
            <div
                className="hidden md:block fixed top-0 left-0 w-12 h-12 bg-white rounded-full mix-blend-difference pointer-events-none z-[9999] transition-transform duration-100 ease-out"
                style={{
                    transform: `translate(${mousePos.x}px, ${mousePos.y}px) translate(-50%, -50%)`
                }}
            />

            {/* Final Scroll Dimming Overlay (Positioned above machine, below text) */}
            <div className="hero-dim-overlay absolute inset-0 bg-black opacity-0 z-20 pointer-events-none" />



            {/* Interactive Machine Wrapper */}
            <div
                ref={imageWrapperRef}
                className="absolute inset-0 flex items-center justify-center z-0 pointer-events-none"
            >
                <div className="relative w-screen h-screen flex items-center justify-center transform-gpu">


                    <Image
                        src="/SSCMHero.webp"
                        alt="SSCM Machine"
                        fill
                        sizes="100vw"
                        className="relative z-10 object-cover drop-shadow-[0_0_150px_rgba(var(--primary),0.3)] transition-transform duration-500 ease-out"
                        priority
                    />
                </div>
            </div>

            {/* Phase 0: Immediate Reveal Text */}
            <div className="absolute inset-0 z-30 flex items-end justify-start pointer-events-none px-6 sm:px-12 md:px-24 pb-12 sm:pb-24">
                <div ref={startTextRef} className="flex flex-col gap-0">
                    <span className="editorial-caps text-primary block mb-2">01 / FOAM & BRUSH</span>
                    <h2 className="text-5xl md:text-[8rem] font-black tracking-tighter text-white uppercase italic leading-[0.85] pb-4">
                        SHOE <br /> <span className="text-primary text-outline">CLEANING</span>
                    </h2>
                </div>
            </div>

            {/* Cinematic Text Reveals */}
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center pointer-events-none overflow-hidden">
                {/* Layer 1: CLEANING */}
                <div ref={introText1Ref} className="w-full px-6 sm:px-12 md:px-32 relative opacity-0 translate-y-24 scale-50 flex justify-start">
                    <div className="absolute top-1/2 left-0 -translate-y-1/2 opacity-10 text-[30rem] font-black tracking-tighter text-white whitespace-nowrap parallax-bg-1 blur-sm pointer-events-none hidden sm:block">
                        DRYING
                    </div>

                    <div className="relative z-10 flex flex-col items-start translate-x-[-10%]">
                        <span className="editorial-caps text-primary/60 mb-2">02 / HEAT & AIR</span>
                        <div className="overflow-hidden reveal-text-1-mask border-l-4 border-primary pl-12 pb-8">
                            <h2 className="text-5xl md:text-[8rem] font-black tracking-tighter text-white uppercase mb-0 leading-[0.85] italic">
                                {"DRYING".split("").map((c, i) => (
                                    <span key={i} className="reveal-char-1 inline-block">{c}</span>
                                ))}
                                <span className="block text-primary pr-12">
                                    TECHNOLOGY
                                </span>
                            </h2>
                        </div>
                    </div>

                    <div className="absolute bottom-[-150px] left-32 opacity-40 text-[8px] sm:text-xs font-mono tracking-[1em] text-primary whitespace-nowrap parallax-bg-2 uppercase">
                        [ 40.7128° C, 74.0060° F ]
                    </div>
                </div>

                {/* Layer 2: HYGIENE */}
                <div ref={introText2Ref} className="w-full px-6 sm:px-12 md:px-32 absolute relative opacity-0 translate-y-24 scale-50 flex justify-end">
                    <div className="absolute top-1/2 right-0 -translate-y-1/2 opacity-10 text-[30rem] font-black tracking-tighter text-white whitespace-nowrap parallax-bg-3 blur-sm pointer-events-none text-right hidden sm:block">
                        PURE
                    </div>

                    <div className="relative z-10 flex flex-col items-end translate-x-[10%] text-right">
                        <span className="editorial-caps text-white mb-2">03 / UV-C & MIST</span>
                        <div className="overflow-hidden reveal-text-2-mask border-r-4 border-white pr-12 pb-8">
                            <h2 className="text-5xl md:text-[8rem] font-black tracking-tighter text-white uppercase mb-0 leading-[0.85] italic">
                                {"PURE".split("").map((c, i) => (
                                    <span key={i} className="reveal-char-2 inline-block text-primary">{c}</span>
                                ))}
                                <br />
                                {"STERILIZING".split("").map((c, i) => (
                                    <span key={i} className="reveal-char-2 inline-block">{c}</span>
                                ))}
                            </h2>
                        </div>
                    </div>

                    <div className="absolute top-[-200px] right-32 opacity-40 text-[8px] sm:text-xs font-mono tracking-[1em] text-white whitespace-nowrap parallax-bg-4 uppercase">
                        HYGIENE_STATUS: OPTIMAL
                    </div>
                </div>


            </div>

            {/* Main Content Overlay */}
            <div ref={contentRef} className="absolute inset-0 z-40 flex flex-col items-start justify-center pointer-events-none px-6 sm:px-12 md:px-24 opacity-0 translate-y-24">
                <div className="max-w-6xl text-left pointer-events-auto">
                    <span className="editorial-caps text-primary mb-6 sm:mb-12 block">04 / SMART SHOE CARE MACHINE</span>
                    <h1 className="text-6xl md:text-[7rem] lg:text-[8.5rem] font-black tracking-tighter leading-[0.75] mb-6 sm:mb-12 uppercase italic">
                        SMART SHOE <br /> <span className="text-primary text-outline">CARE MACHINE</span>
                    </h1>

                    <div className="flex flex-col md:flex-row items-start justify-start gap-6 sm:gap-12 mb-8 sm:mb-16 max-w-2xl">
                        <div className="text-base sm:text-lg md:text-2xl text-muted-foreground font-medium leading-tight">
                            The future of Shoe Care. An IoT Automated Solution for Cleaning, Sterilization and Drying Shoes with Integrated Image Recognition
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-start gap-8">
                        <div
                            onClick={() => {
                                const contact = document.getElementById('contact');
                                if (contact) {
                                    contact.scrollIntoView({ behavior: 'smooth' });
                                }
                            }}
                            className="group relative px-12 py-6 bg-primary text-primary-foreground rounded-sm font-black uppercase tracking-[0.2em] transition-all duration-500 hover:tracking-[0.4em] overflow-hidden cursor-pointer pointer-events-auto"
                        >
                            <span className="relative z-10">Order Now</span>
                            <div className="absolute inset-0 bg-white translate-y-full group-hover:translate-y-0 transition-transform duration-500 mix-blend-difference" />
                        </div>
                        <Link
                            href="/client/login"
                            className="editorial-caps text-white border-b border-white/20 pb-2 hover:text-primary hover:border-primary transition-colors"
                        >
                            Explore Interface
                        </Link>
                    </div>
                </div>
            </div>

            {/* Enhanced Scroll Indicator */}
            <div className="absolute bottom-12 left-1/2 -translate-x-1/2 flex flex-col items-center gap-4 text-muted-foreground/30 z-50">
                <span className="text-[9px] uppercase tracking-[0.6em] font-mono">ENGAGE SYSTEM</span>
                <div className="h-12 w-px bg-gradient-to-b from-primary/50 to-transparent animate-bounce" />
            </div>
        </div>
    )
}


