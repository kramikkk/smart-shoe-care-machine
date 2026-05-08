'use client'

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ArrowRight, ArrowLeftRight, Loader2 } from "lucide-react"
import { getStatusBadge } from "@/lib/transactionStatus"
import Link from "next/link"
import { useEffect, useState } from "react"
import { useDeviceFilter } from "@/contexts/DeviceFilterContext"

type Transaction = {
  id: string
  dateTime: string
  paymentMethod: string
  serviceType: string
  shoeType: string
  careType: string
  amount: number
  status?: string | null
}


const RecentTransactionTable = () => {
  const { selectedDevice } = useDeviceFilter()
  const [recentTransactions, setRecentTransactions] = useState<Transaction[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Fetch recent transactions from API
  useEffect(() => {
    const controller = new AbortController()
    setIsLoading(true)
    setError(null)
    const fetchTransactions = async () => {
      try {
        const response = await fetch(`/api/transaction/list?deviceId=${selectedDevice}`, { signal: controller.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        const data = await response.json()

        if (data.success) {
          // Get last 7 transactions and format dateTime
          const recent = data.transactions.slice(0, 7).map((tx: any) => ({
            ...tx,
            dateTime: new Date(tx.dateTime).toLocaleString('en-US', {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            }).replace(',', ''),
          }))
          setRecentTransactions(recent)
        } else {
          setError('Failed to load transactions')
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        setError('Failed to load transactions')
      } finally {
        setIsLoading(false)
      }
    }

    fetchTransactions()
    return () => controller.abort()
  }, [selectedDevice])

  return (
    <div className="flex flex-col h-full">
        <Card className="flex flex-col h-full glass-card border-none">
            <CardHeader className="shrink-0">
                <div className="flex items-center gap-2">
                  <ArrowLeftRight className="text-purple-500" />
                  <CardTitle>Recent <span className="text-primary">Transactions</span></CardTitle>
                </div>
                <CardAction>
                  <Link
                    href="/client/dashboard/transactions"
                    className="flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                  >
                    View All
                    <ArrowRight className="size-4" />
                  </Link>
                </CardAction>
            </CardHeader>
            <CardContent className="flex-1 min-h-0 overflow-hidden">
                {error ? (
                  <div className="flex items-center justify-center h-full">
                    <div className="text-destructive text-sm">{error}</div>
                  </div>
                ) : isLoading ? (
                  <div className="flex items-center justify-center h-full">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : recentTransactions.length === 0 ? (
                  <div className="flex items-center justify-center h-full">
                    <div className="text-muted-foreground">No transactions yet</div>
                  </div>
                ) : (
                <div className="overflow-x-auto h-full">
                  <Table>
                      <TableHeader>
                          <TableRow>
                          <TableHead className="whitespace-nowrap">ID</TableHead>
                          <TableHead className="whitespace-nowrap hidden sm:table-cell">Date & Time</TableHead>
                          <TableHead className="whitespace-nowrap hidden md:table-cell">Method</TableHead>
                          <TableHead className="whitespace-nowrap">Service</TableHead>
                          <TableHead className="whitespace-nowrap hidden lg:table-cell">Shoe Type</TableHead>
                          <TableHead className="whitespace-nowrap hidden xl:table-cell">Care Type</TableHead>
                          <TableHead className="whitespace-nowrap hidden md:table-cell">Status</TableHead>
                          <TableHead className="whitespace-nowrap">Amount</TableHead>
                          </TableRow>
                      </TableHeader>
                      <TableBody>
                          {recentTransactions.map((transaction) => {
                            const badge = getStatusBadge(transaction.status)
                            return (
                            <TableRow key={transaction.id}>
                              <TableCell className="font-medium font-mono text-xs max-w-[80px] sm:max-w-[120px] truncate">{transaction.id}</TableCell>
                              <TableCell className="whitespace-nowrap text-sm hidden sm:table-cell">{transaction.dateTime}</TableCell>
                              <TableCell className="whitespace-nowrap hidden md:table-cell">{transaction.paymentMethod}</TableCell>
                              <TableCell className="whitespace-nowrap">{transaction.serviceType}</TableCell>
                              <TableCell className="whitespace-nowrap hidden lg:table-cell">{transaction.shoeType}</TableCell>
                              <TableCell className="whitespace-nowrap hidden xl:table-cell">{transaction.careType}</TableCell>
                              <TableCell className="whitespace-nowrap hidden md:table-cell">
                                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${badge.className}`}>
                                  {badge.label}
                                </span>
                              </TableCell>
                              <TableCell className="whitespace-nowrap">
                                {new Intl.NumberFormat("en-US", {
                                  style: "currency",
                                  currency: "PHP",
                                }).format(transaction.amount)}
                              </TableCell>
                            </TableRow>
                            )
                          })}
                      </TableBody>
                  </Table>
                </div>
                )}
            </CardContent>
        </Card>
    </div>
  )
}

export default RecentTransactionTable
