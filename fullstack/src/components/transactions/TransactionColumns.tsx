"use client"

import { ColumnDef } from "@tanstack/react-table"
import { getStatusBadge } from "@/lib/transactionStatus"

export type Transaction = {
  id: string
  dateTime: string
  paymentMethod: "Cash" | "Online"
  serviceType: "Cleaning" | "Drying" | "Sterilizing" | "Package"
  shoeType: "Canvas" | "Rubber" | "Mesh"
  careType: "Gentle" | "Normal" | "Strong" | "Auto"
  amount: number
  amountPaid?: number | null
  deviceId?: string | null
  status?: string | null
}


export const columns: ColumnDef<Transaction>[] = [
  {
    accessorKey: "id",
    header: "Transaction ID",
  },
  {
    accessorKey: "dateTime",
    header: "Date & Time",
  },
  {
    accessorKey: "paymentMethod",
    header: "Payment Method",
  },
  {
    accessorKey: "serviceType",
    header: "Service Type",
  },
  {
    accessorKey: "shoeType",
    header: "Shoe Type",
  },
  {
    accessorKey: "careType",
    header: "Care Type",
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => {
      const badge = getStatusBadge(row.getValue<string | null>("status"))
      return (
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${badge.className}`}>
          {badge.label}
        </span>
      )
    },
  },
  {
    accessorKey: "amount",
    header: () => <div>Amount</div>,
    cell: ({ row }) => {
      const amount = row.getValue<number>("amount")
      const amountPaid = row.original.amountPaid
      const isCash = row.original.paymentMethod === "Cash"
      const excess =
        isCash && amountPaid != null && amountPaid > amount ? amountPaid - amount : 0

      const fmt = (v: number) =>
        new Intl.NumberFormat("en-US", { style: "currency", currency: "PHP" }).format(v)

      return (
        <div className="flex flex-col gap-0.5">
          <span>{fmt(amount)}</span>
          {excess > 0 && (
            <span className="text-[10px] font-semibold text-amber-400/80 leading-none">
              +{fmt(excess)} excess
            </span>
          )}
        </div>
      )
    },
  },
]
