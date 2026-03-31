"use client"

import {
  EllipsisVertical,
} from "lucide-react"

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { useState } from "react"
import { UserProfileDialog } from "./UserProfileDialog"
import { getInitials } from "@/lib/utils/strings"

export function SideBarUser({
  user,
  onProfileUpdated,
}: {
  user: {
    name: string
    email: string
    avatar: string
  }
  onProfileUpdated?: (name: string, image: string) => void
}) {
  const [isProfileOpen, setIsProfileOpen] = useState(false)

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            size="lg"
            className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            onClick={() => setIsProfileOpen(true)}
          >
            <Avatar className="h-8 w-8 rounded-lg grayscale">
              <AvatarImage src={user.avatar} alt={user.name} />
              <AvatarFallback className="rounded-lg">{getInitials(user.name)}</AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{user.name}</span>
              <span className="text-muted-foreground truncate text-xs">
                {user.email}
              </span>
            </div>
            <EllipsisVertical className="ml-auto size-4" />
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>

      <UserProfileDialog
        user={user}
        open={isProfileOpen}
        onOpenChange={setIsProfileOpen}
        onProfileUpdated={onProfileUpdated}
      />
    </>
  )
}
