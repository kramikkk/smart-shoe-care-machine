import PageLoader from "@/components/ui/PageLoader"

export default function TransactionsLoading() {
  return (
    <div className="flex flex-1 flex-col w-full">
      <PageLoader label="Loading transactions" />
    </div>
  )
}
