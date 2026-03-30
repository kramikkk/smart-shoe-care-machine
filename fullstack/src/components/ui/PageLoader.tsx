export default function PageLoader({ label }: { label?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 min-h-[60vh]">
      {/* Spinner ring */}
      <div className="relative w-12 h-12">
        <div className="absolute inset-0 rounded-full border-2 border-white/5" />
        <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-primary animate-spin" />
        <div className="absolute inset-[4px] rounded-full border border-transparent border-t-primary/40 animate-spin [animation-duration:1.5s]" />
      </div>

      {label && (
        <p className="text-[11px] uppercase tracking-[0.2em] font-semibold text-muted-foreground/50 animate-pulse">
          {label}
        </p>
      )}
    </div>
  )
}
