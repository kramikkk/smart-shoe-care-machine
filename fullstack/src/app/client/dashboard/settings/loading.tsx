import PageLoader from "@/components/ui/PageLoader"

export default function SettingsLoading() {
  return (
    <div className="flex flex-1 flex-col w-full">
      <PageLoader label="Loading settings" />
    </div>
  )
}
