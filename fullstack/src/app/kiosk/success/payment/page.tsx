"use client";
import { CheckCircle } from "lucide-react";
import { useSearchParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export default function PaymentSuccess() {
  const searchParams = useSearchParams();
  const shoe = searchParams.get('shoe') || 'mesh';
  const service = searchParams.get('service');
  const care = searchParams.get('care');
  const transactionId = searchParams.get('transactionId') || '';
  const router = useRouter();
  const [countdown, setCountdown] = useState(5);

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
      const txParam = transactionId ? `&transactionId=${transactionId}` : ''
      if (service === 'package') {
        router.push(`/kiosk/mode/auto?shoe=${shoe}${txParam}`);
      } else if (service) {
        router.push(`/kiosk/mode/custom/progress?shoe=${shoe}&service=${service}&care=${care || 'normal'}${txParam}`);
      } else {
        router.push('/kiosk');
      }
    }
  }, [countdown, shoe, service, care, router]);

  const getMessage = () => {
    if (service === 'package') {
      return "Full automatic cleaning process will begin shortly.";
    }
    if (service === 'cleaning') {
      return "Cleaning process will begin shortly.";
    }
    if (service === 'drying') {
      return "Drying process will begin shortly.";
    }
    if (service === 'sterilizing') {
      return "Sterilization process will begin shortly.";
    }
    return "Process will begin shortly.";
  };

  const getServiceName = () => {
    if (service === 'package') return 'Package';
    if (service === 'cleaning') return 'Cleaning';
    if (service === 'drying') return 'Drying';
    if (service === 'sterilizing') return 'Sterilizing';
    if (service) return service.charAt(0).toUpperCase() + service.slice(1);
    return 'Service';
  };

  const getShoeName = () => {
    return shoe.charAt(0).toUpperCase() + shoe.slice(1);
  };

  const getCareName = () => {
    if (care) return care.charAt(0).toUpperCase() + care.slice(1);
    return 'Normal';
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen text-center px-4 py-6">
      <div className="bg-white/80 py-8 px-10 rounded-3xl shadow-2xl backdrop-blur-md w-[500px]">
        {/* Success Icon */}
        <div className="mb-4 flex justify-center">
          <div className="w-32 h-32 rounded-full bg-gradient-to-br from-green-400 to-emerald-500 flex items-center justify-center shadow-xl">
            <CheckCircle className="w-16 h-16 text-white" strokeWidth={2.5} />
          </div>
        </div>

        {/* Success Title */}
        <h1 className="text-3xl font-bold text-green-600 mb-3">Payment Successful!</h1>

        {/* Service Info Badges */}
        <div className="flex flex-wrap justify-center gap-2 mb-4">
          <span className="inline-block px-4 py-1.5 bg-gradient-to-r from-purple-100 to-pink-100 rounded-full text-sm font-semibold text-purple-800 shadow-sm">
            {getShoeName()} Type
          </span>
          <span className="inline-block px-4 py-1.5 bg-gradient-to-r from-blue-100 to-cyan-100 rounded-full text-sm font-semibold text-blue-800 shadow-sm">
            {getServiceName()}
          </span>
          <span className="inline-block px-4 py-1.5 bg-gradient-to-r from-green-100 to-emerald-100 rounded-full text-sm font-semibold text-green-800 shadow-sm">
            {getCareName()} Care
          </span>
        </div>

        {/* Message */}
        <p className="text-base text-gray-700 mb-4 leading-relaxed">{getMessage()}</p>

        {/* Countdown */}
        <div className="bg-gradient-to-r from-blue-50 to-cyan-50 py-3 px-5 rounded-xl">
          <p className="text-gray-600 text-base">Starting in</p>
          <p className="text-4xl font-bold bg-gradient-to-r from-blue-600 via-cyan-600 to-green-600 bg-clip-text text-transparent">
            {countdown}
          </p>
          <p className="text-gray-600 text-base">seconds</p>
        </div>
      </div>
    </div>
  );
}