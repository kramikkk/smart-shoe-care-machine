'use client'

import React, { createContext, useContext, useState, useEffect, useRef } from 'react'

export const SELECTED_DEVICE_KEY = 'dashboard_selected_device'

type DeviceFilterContextType = {
  selectedDevice: string // deviceId
  setSelectedDevice: (deviceId: string) => void
  devices: Array<{ deviceId: string }>
  isLoading: boolean
  refreshDevices: () => Promise<void>
}

const DeviceFilterContext = createContext<DeviceFilterContextType | undefined>(undefined)

export function DeviceFilterProvider({ children }: { children: React.ReactNode }) {
  // Initialise from localStorage so DashboardWebSocketContext can start its WS connection
  // immediately on return visits, without waiting for the device list fetch.
  const [selectedDevice, setSelectedDeviceState] = useState<string>(() => {
    if (typeof window === 'undefined') return ''
    return localStorage.getItem(SELECTED_DEVICE_KEY) ?? ''
  })
  const [devices, setDevices] = useState<Array<{ deviceId: string }>>([])
  const [isLoading, setIsLoading] = useState(true)
  const fetchingRef = useRef(false)

  const setSelectedDevice = (deviceId: string) => {
    setSelectedDeviceState(deviceId)
    if (typeof window !== 'undefined') {
      localStorage.setItem(SELECTED_DEVICE_KEY, deviceId)
    }
  }

  const fetchDevices = async () => {
    if (fetchingRef.current) return
    fetchingRef.current = true
    try {
      const response = await fetch('/api/device/list')
      const data = await response.json()

      if (data.success) {
        const deviceList = data.devices
          .filter((device: any) => device.paired) // Only show paired devices
          .map((device: any) => ({
            deviceId: device.deviceId,
          }))
        setDevices(deviceList)

        // If the cached device is no longer in the paired list, fall back to first
        const cachedStillValid = deviceList.some((d: { deviceId: string }) => d.deviceId === selectedDevice)
        if (deviceList.length > 0 && !cachedStillValid) {
          setSelectedDevice(deviceList[0].deviceId)
        }
      }
    } catch (error) {
      console.error('Error fetching devices:', error)
    } finally {
      fetchingRef.current = false
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchDevices()
  }, [])

  const refreshDevices = async () => {
    setIsLoading(true)
    await fetchDevices()
  }

  return (
    <DeviceFilterContext.Provider
      value={{
        selectedDevice,
        setSelectedDevice,
        devices,
        isLoading,
        refreshDevices
      }}
    >
      {children}
    </DeviceFilterContext.Provider>
  )
}

export function useDeviceFilter() {
  const context = useContext(DeviceFilterContext)
  if (context === undefined) {
    throw new Error('useDeviceFilter must be used within a DeviceFilterProvider')
  }
  return context
}
