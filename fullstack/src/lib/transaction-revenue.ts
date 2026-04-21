/**
 * Revenue for dashboards and reports.
 * Cash: use tendered amount when recorded (includes customer excess); never below list price.
 * Online: list price only — amountPaid can exceed amount due to payment fees.
 */
export function recordedRevenue(tx: {
  paymentMethod: string
  amount: number
  amountPaid: number | null
}): number {
  if (tx.paymentMethod === 'Cash') {
    return Math.max(tx.amount, tx.amountPaid ?? tx.amount)
  }
  return tx.amount
}
