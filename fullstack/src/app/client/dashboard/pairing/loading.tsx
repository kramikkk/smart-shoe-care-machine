import PageLoader from "@/components/ui/PageLoader"

export default function Loading() {
  return (
    <div className="flex flex-1 flex-col w-full">
      <PageLoader label="Loading device pairing" />
    </div>
  )
}
