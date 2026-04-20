'use client'

import { createContext, useContext, useState } from 'react'
import React from 'react'

export type TimeRange = 'today' | 'week' | 'month' | 'year' | 'all'

interface TimeRangeContextType {
  timeRange: TimeRange
  setTimeRange: (range: TimeRange) => void
}

const TimeRangeContext = createContext<TimeRangeContextType>({
  timeRange: 'today',
  setTimeRange: () => {},
})

export function TimeRangeProvider({ children }: { children: React.ReactNode }) {
  const [timeRange, setTimeRange] = useState<TimeRange>('today')
  return (
    <TimeRangeContext.Provider value={{ timeRange, setTimeRange }}>
      {children}
    </TimeRangeContext.Provider>
  )
}

export const useTimeRange = () => useContext(TimeRangeContext)
