const PAYMONGO_API_URL = 'https://api.paymongo.com/v1'

type PayMongoAuthConfig = {
  authType: 'basic' | 'bearer'
  token: string
}

export class PayMongoClient {
  private readonly authHeader: string

  constructor(private readonly auth: PayMongoAuthConfig) {
    if (!auth.token) {
      throw new Error('PayMongo auth token is required')
    }

    this.authHeader = auth.authType === 'basic'
      ? `Basic ${Buffer.from(auth.token).toString('base64')}`
      : `Bearer ${auth.token}`
  }

  private withAuthHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': this.authHeader,
    }
  }

  /**
   * Step 1: Create Payment Intent with QRPH enabled
   */
  async createPaymentIntent(amount: number, description: string, metadata?: Record<string, string>) {
    console.log('Creating Payment Intent with QRPH')

    const attributes: any = {
      amount: Math.round(amount * 100), // Convert to cents (₱50 = 5000 cents)
      payment_method_allowed: ['qrph'], // Enable QRPH
      currency: 'PHP',
      description: description,
      statement_descriptor: 'Smart Shoe Care',
    }

    // Only include metadata if provided
    if (metadata && Object.keys(metadata).length > 0) {
      attributes.metadata = metadata
    }

    const response = await fetch(`${PAYMONGO_API_URL}/payment_intents`, {
      method: 'POST',
      headers: this.withAuthHeaders(),
      body: JSON.stringify({
        data: {
          attributes
        }
      })
    })

    if (!response.ok) {
      const error = await response.json()
      console.error('PayMongo Create Payment Intent Error:', error)
      throw new Error(error.errors?.[0]?.detail || 'Failed to create payment intent')
    }

    const result = await response.json()
    console.log('Payment Intent Created:', {
      id: result.data.id,
      status: result.data.attributes.status
    })
    
    return result
  }

  /**
   * Step 2: Create QRPH Payment Method
   */
  async createPaymentMethod() {
    console.log('Creating QRPH Payment Method')

    const response = await fetch(`${PAYMONGO_API_URL}/payment_methods`, {
      method: 'POST',
      headers: this.withAuthHeaders(),
      body: JSON.stringify({
        data: {
          attributes: {
            type: 'qrph',
          }
        }
      })
    })

    if (!response.ok) {
      const error = await response.json()
      console.error('PayMongo Create Payment Method Error:', error)
      throw new Error(error.errors?.[0]?.detail || 'Failed to create payment method')
    }

    const result = await response.json()
    console.log('Payment Method Created:', result.data.id)
    
    return result
  }

  /**
   * Step 3: Attach Payment Method to Payment Intent
   */
  async attachPaymentMethod(paymentIntentId: string, paymentMethodId: string) {
    console.log('Attaching Payment Method to Payment Intent')

    const response = await fetch(
      `${PAYMONGO_API_URL}/payment_intents/${paymentIntentId}/attach`,
      {
        method: 'POST',
        headers: this.withAuthHeaders(),
        body: JSON.stringify({
          data: {
            attributes: {
              payment_method: paymentMethodId,
            }
          }
        })
      }
    )

    if (!response.ok) {
      const error = await response.json()
      console.error('PayMongo Attach Payment Method Error:', error)
      throw new Error(error.errors?.[0]?.detail || 'Failed to attach payment method')
    }

    const result = await response.json()
    
    // Extract QR code image URL from next_action
    const imageUrl = result.data.attributes.next_action?.code?.image_url
    
    console.log('Payment Method Attached:', {
      paymentIntentId: result.data.id,
      status: result.data.attributes.status,
      hasQRCode: !!imageUrl
    })
    
    return result
  }

  /**
   * Check Payment Status using Payment Intent ID
   */
  async getPaymentIntentStatus(paymentIntentId: string) {
    const response = await fetch(
      `${PAYMONGO_API_URL}/payment_intents/${paymentIntentId}`,
      {
        method: 'GET',
        headers: this.withAuthHeaders(),
      }
    )

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.errors?.[0]?.detail || 'Failed to retrieve payment intent status')
    }

    return await response.json()
  }

  /**
   * Cancel/Void a Payment Intent
   * This prevents the QR code from being used after user cancels
   */
  async cancelPaymentIntent(paymentIntentId: string) {
    console.log('Cancelling Payment Intent:', paymentIntentId)

    const response = await fetch(
      `${PAYMONGO_API_URL}/payment_intents/${paymentIntentId}/cancel`,
      {
        method: 'POST',
        headers: this.withAuthHeaders(),
      }
    )

    if (!response.ok) {
      const error = await response.json()
      console.error('PayMongo Cancel Payment Intent Error:', error)
      throw new Error(error.errors?.[0]?.detail || 'Failed to cancel payment intent')
    }

    const result = await response.json()
    console.log('Payment Intent Cancelled:', result.data.attributes.status)
    
    return result
  }
}