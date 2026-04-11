"use client";

import { Button } from "@/components/ui/button";
import { OctagonAlert } from "lucide-react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Shown after emergency stop: same card layout as service success, neutral “stopped” messaging.
 */
export default function KioskStoppedPage() {
  const searchParams = useSearchParams();
  const shoe = searchParams.get("shoe") || "mesh";
  const service = searchParams.get("service");
  const care = searchParams.get("care");
  const router = useRouter();
  const [countdown, setCountdown] = useState(10);

  useEffect(() => {
    const countdownInterval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(countdownInterval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(countdownInterval);
  }, []);

  useEffect(() => {
    if (countdown === 0) {
      router.push("/kiosk");
    }
  }, [countdown, router]);

  const getServiceName = () => {
    if (service === "package") return "Package";
    if (service === "cleaning") return "Cleaning";
    if (service === "drying") return "Drying";
    if (service === "sterilizing") return "Sterilizing";
    if (service) return service.charAt(0).toUpperCase() + service.slice(1);
    return "Service";
  };

  const getShoeName = () => {
    return shoe.charAt(0).toUpperCase() + shoe.slice(1);
  };

  const getCareName = () => {
    if (care) return care.charAt(0).toUpperCase() + care.slice(1);
    if (service === "package") return "Auto";
    return "Normal";
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-6 text-center">
      <div className="w-[500px] rounded-3xl bg-white/80 px-10 py-8 shadow-2xl backdrop-blur-md">
        <div className="mb-4 flex justify-center">
          <div className="flex h-32 w-32 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-orange-500 shadow-xl">
            <OctagonAlert className="h-16 w-16 text-white" strokeWidth={2} />
          </div>
        </div>

        <p className="mb-1 text-2xl font-bold text-orange-600">
          Session ended
        </p>
        <h1 className="mb-3 text-3xl font-bold text-red-600">Emergency stopped</h1>

        <div className="mb-4 flex flex-wrap justify-center gap-2">
          <span className="inline-block rounded-full bg-gradient-to-r from-purple-100 to-pink-100 px-4 py-1.5 text-sm font-semibold text-purple-800 shadow-sm">
            {getShoeName()} Type
          </span>
          <span className="inline-block rounded-full bg-gradient-to-r from-blue-100 to-cyan-100 px-4 py-1.5 text-sm font-semibold text-blue-800 shadow-sm">
            {getServiceName()}
          </span>
          <span className="inline-block rounded-full bg-gradient-to-r from-green-100 to-emerald-100 px-4 py-1.5 text-sm font-semibold text-green-800 shadow-sm">
            {getCareName()} Care
          </span>
        </div>

        <p className="mb-4 text-base leading-relaxed text-gray-700">
          The machine was stopped safely. This cycle did not finish. You can start again from the
          home screen when you are ready.
        </p>

        <div className="mb-6 rounded-xl bg-gradient-to-r from-blue-50 to-cyan-50 px-5 py-3">
          <p className="text-base text-gray-600">Returning home in</p>
          <p className="bg-gradient-to-r from-blue-600 via-cyan-600 to-green-600 bg-clip-text text-4xl font-bold text-transparent">
            {countdown}
          </p>
          <p className="text-base text-gray-600">seconds</p>
        </div>

        <div className="flex justify-center pt-1">
          <Link href="/kiosk">
            <Button
              type="button"
              className="rounded-full bg-gradient-to-r from-blue-600 via-cyan-600 to-green-600 px-10 py-5 text-lg font-bold text-white shadow-lg transition-all duration-200 hover:scale-105 hover:from-blue-700 hover:via-cyan-700 hover:to-green-700 active:scale-95"
            >
              Return Home
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
