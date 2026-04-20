"use client"

import { useState, useMemo, useEffect } from "react"
import { motion } from "motion/react"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { CalendarIcon, X, Search, Download, FileJson, FileText, ChevronDown } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { TransactionDataTable } from "@/components/transactions/TransactionDataTable"
import { columns, Transaction } from "@/components/transactions/TransactionColumns"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { format } from "date-fns"
import { useDeviceFilter } from "@/contexts/DeviceFilterContext"

export default function TransactionsPage() {
  const { selectedDevice } = useDeviceFilter()
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [search, setSearch] = useState("")
  const [paymentFilter, setPaymentFilter] = useState<string>("all")
  const [serviceFilter, setServiceFilter] = useState<string>("all")
  const [shoeTypeFilter, setShoeTypeFilter] = useState<string>("all")
  const [careTypeFilter, setCareTypeFilter] = useState<string>("all")
  // statusFilter kept for UI but not sent to API (no status field on Transaction)
  const [statusFilter, setStatusFilter] = useState<string>("all")
  const [dateFrom, setDateFrom] = useState<Date | undefined>(undefined)
  const [dateTo, setDateTo] = useState<Date | undefined>(undefined)

  // Fetch transactions from database
  useEffect(() => {
    const controller = new AbortController()

    const fetchTransactions = async () => {
      try {
        const params = new URLSearchParams()
        params.set('deviceId', selectedDevice || '')
        params.set('limit', '500')
        if (paymentFilter !== 'all') params.set('paymentMethod', paymentFilter)
        if (dateFrom) params.set('startDate', dateFrom.toISOString())
        if (dateTo) {
          const end = new Date(dateTo)
          end.setHours(23, 59, 59, 999)
          params.set('endDate', end.toISOString())
        }
        const response = await fetch(`/api/transaction/list?${params}`, { signal: controller.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        const data = await response.json()

        if (data.success) {
          const formattedTransactions = data.transactions.map((tx: any) => {
            return {
              ...tx,
              dateTime: new Date(tx.dateTime).toLocaleString('en-US', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
              }).replace(',', ''),
            }
          })
          setTransactions(formattedTransactions as any)
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return
      }
    }

    fetchTransactions()

    return () => controller.abort()
  }, [selectedDevice, paymentFilter, dateFrom, dateTo])

  const filteredData = useMemo(() => {
    return transactions.filter((tx) => {
      const searchLower = search.toLowerCase()
      const matchesSearch =
        search === "" ||
        tx.id.toLowerCase().includes(searchLower) ||
        tx.serviceType.toLowerCase().includes(searchLower) ||
        tx.shoeType.toLowerCase().includes(searchLower) ||
        tx.careType.toLowerCase().includes(searchLower) ||
        tx.paymentMethod.toLowerCase().includes(searchLower) ||
        tx.dateTime.toLowerCase().includes(searchLower) ||
        tx.amount.toString().includes(searchLower)

      const matchesService =
        serviceFilter === "all" || tx.serviceType === serviceFilter

      const matchesShoeType =
        shoeTypeFilter === "all" || tx.shoeType === shoeTypeFilter

      const matchesCareType =
        careTypeFilter === "all" || tx.careType === careTypeFilter

      return matchesSearch && matchesService && matchesShoeType && matchesCareType
    })
  }, [transactions, search, serviceFilter, shoeTypeFilter, careTypeFilter])

  const filename = `SSCM_Transactions_${format(new Date(), "yyyy-MM-dd")}`

  const triggerDownload = (content: string, name: string, mime: string) => {
    const blob = new Blob([content], { type: mime })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = name
    link.style.visibility = "hidden"
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  const handleExportCSV = () => {
    if (filteredData.length === 0) return
    const headers = ["Transaction ID", "Date & Time", "Payment Method", "Service Type", "Shoe Type", "Care Type", "Amount (PHP)"]
    const rows = filteredData.map(tx => [
      `"${tx.id}"`,
      `"${tx.dateTime}"`,
      `"${tx.paymentMethod}"`,
      `"${tx.serviceType}"`,
      `"${tx.shoeType}"`,
      `"${tx.careType}"`,
      tx.amount,
    ].join(","))
    triggerDownload([headers.join(","), ...rows].join("\n"), `${filename}.csv`, "text/csv;charset=utf-8;")
  }

  const handleExportJSON = () => {
    if (filteredData.length === 0) return
    const data = filteredData.map(tx => ({
      id: tx.id,
      dateTime: tx.dateTime,
      paymentMethod: tx.paymentMethod,
      serviceType: tx.serviceType,
      shoeType: tx.shoeType,
      careType: tx.careType,
      amount: tx.amount,
    }))
    triggerDownload(JSON.stringify(data, null, 2), `${filename}.json`, "application/json")
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6 }}
      className="w-full pb-8"
    >
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Transaction <span className="text-primary">History</span></h1>
          <p className="text-muted-foreground">Showing {filteredData.length} records.</p>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={filteredData.length === 0}
              className="h-9 border-white/10 bg-white/5 hover:bg-primary/10 hover:text-primary transition-all gap-2"
            >
              <Download className="size-4" />
              <span className="hidden sm:inline">Export</span>
              <ChevronDown className="size-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="bg-card/98 border-white/10 backdrop-blur-2xl">
            <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-muted-foreground/50">
              {filteredData.length} records
            </DropdownMenuLabel>
            <DropdownMenuSeparator className="bg-white/5" />
            <DropdownMenuItem onClick={handleExportCSV} className="gap-2 cursor-pointer">
              <FileText className="size-4 text-green-400" />
              Export as CSV
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleExportJSON} className="gap-2 cursor-pointer">
              <FileJson className="size-4 text-blue-400" />
              Export as JSON
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Card className="glass-card border-none overflow-hidden gap-0 py-2">
        <CardContent className="px-4 sm:px-6 pt-4 pb-6 border-none">
          <div className="flex flex-col gap-5">
            {/* Premium Search & Filter Toolbar */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2, duration: 0.5 }}
              className="flex flex-col gap-6 p-4 rounded-2xl bg-white/[0.02] border border-white/5"
            >
              {/* Primary Row: Search & Range */}
              <div className="flex flex-col lg:flex-row gap-3">
                {/* Unified Search Input */}
                <div className="relative flex-1 group">
                  <div className="absolute inset-0 bg-primary/10 rounded-xl blur-lg opacity-0 group-focus-within:opacity-100 transition-opacity duration-500 pointer-events-none" />
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/50 group-focus-within:text-primary group-focus-within:scale-110 transition-all z-20" />
                  <Input
                    placeholder="Search ID, service, shoe type, care type, payment, or amount..."
                    className="relative z-10 pl-11 pr-11 h-10 border-white/10 bg-white/5 text-sm rounded-xl focus-visible:ring-primary/20 focus-visible:bg-white/[0.08] focus-visible:border-primary/30 transition-all"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  {search && (
                    <button
                      type="button"
                      onClick={() => setSearch("")}
                      className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-red-400 transition-colors z-20"
                    >
                      <X className="size-4" />
                    </button>
                  )}
                </div>

                {/* Date Controls */}
                <div className="flex bg-white/5 p-1 rounded-xl border border-white/10 h-10 shadow-inner">
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        className={`h-full px-3 flex-1 justify-start text-xs font-semibold tracking-wide hover:bg-white/5 rounded-lg transition-colors min-w-[110px] ${!dateFrom && "text-muted-foreground/60"}`}
                      >
                        <CalendarIcon className="mr-1.5 h-3.5 w-3.5 text-primary/70 shrink-0" />
                        <span className="truncate">{dateFrom ? format(dateFrom, "MMM dd, yy") : "Start"}</span>
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0 bg-card/98 border-white/10 backdrop-blur-2xl shadow-2xl" align="start">
                      <Calendar mode="single" selected={dateFrom} onSelect={setDateFrom} initialFocus />
                    </PopoverContent>
                  </Popover>

                  <div className="w-[1px] h-3.5 bg-white/10 self-center mx-1" />

                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        className={`h-full px-3 flex-1 justify-start text-xs font-semibold tracking-wide hover:bg-white/5 rounded-lg transition-colors min-w-[110px] ${!dateTo && "text-muted-foreground/60"}`}
                      >
                        <CalendarIcon className="mr-1.5 h-3.5 w-3.5 text-primary/70 shrink-0" />
                        <span className="truncate">{dateTo ? format(dateTo, "MMM dd, yy") : "End"}</span>
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0 bg-card/98 border-white/10 backdrop-blur-2xl shadow-2xl" align="end">
                      <Calendar mode="single" selected={dateTo} onSelect={setDateTo} initialFocus disabled={(date) => dateFrom ? date < dateFrom : false} />
                    </PopoverContent>
                  </Popover>
                </div>
              </div>

              {/* Secondary Row: Category Filters */}
              <div className="flex flex-col sm:flex-row sm:flex-wrap items-start sm:items-center gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/40 px-1 shrink-0">Filter by</div>

                  {[
                    { label: "Payment", value: paymentFilter, setter: setPaymentFilter, options: ["Cash", "Online"], placeholder: "Payment" },
                    { label: "Service", value: serviceFilter, setter: setServiceFilter, options: ["Cleaning", "Drying", "Sterilizing", "Package"], placeholder: "Service" },
                    { label: "Status", value: statusFilter, setter: setStatusFilter, options: ["Success", "Pending", "Failed"], placeholder: "Status" },
                    { label: "Shoe", value: shoeTypeFilter, setter: setShoeTypeFilter, options: ["Canvas", "Rubber", "Mesh"], placeholder: "Shoe" },
                    { label: "Care", value: careTypeFilter, setter: setCareTypeFilter, options: ["Gentle", "Normal", "Strong", "Auto"], placeholder: "Care" }
                  ].map((filter) => (
                    <Select key={filter.label} value={filter.value} onValueChange={filter.setter}>
                      <SelectTrigger className="h-8 w-[90px] sm:w-[100px] border-white/10 bg-white/5 hover:bg-white/10 hover:border-white/20 text-[11px] font-medium rounded-lg transition-all">
                        <SelectValue placeholder={filter.label} />
                      </SelectTrigger>
                      <SelectContent className="bg-card/98 border-white/10 backdrop-blur-2xl">
                        <SelectItem value="all">{filter.placeholder}</SelectItem>
                        {filter.options.map(opt => <SelectItem key={opt} value={opt}>{opt}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  ))}
                </div>

                <Button
                  variant="ghost"
                  onClick={() => {
                    setPaymentFilter("all"); setServiceFilter("all"); setShoeTypeFilter("all");
                    setCareTypeFilter("all"); setStatusFilter("all"); setDateFrom(undefined); setDateTo(undefined); setSearch("");
                  }}
                  disabled={paymentFilter === "all" && serviceFilter === "all" && shoeTypeFilter === "all" && careTypeFilter === "all" && statusFilter === "all" && !dateFrom && !dateTo && !search}
                  className="h-8 px-4 hover:bg-red-500/10 border-white/5 text-[10px] font-black uppercase tracking-widest text-muted-foreground/60 hover:text-red-400 transition-all rounded-lg group"
                >
                  <X className="size-3 mr-1.5 group-hover:rotate-90 transition-transform duration-300" />
                  <span>Reset</span>
                </Button>
              </div>
            </motion.div>

            {/* Table */}
            <TransactionDataTable columns={columns} data={filteredData} />
          </div>
        </CardContent>
      </Card>
    </motion.div>
  )
}
