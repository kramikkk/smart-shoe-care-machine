"use client"

import {
  LogOut,
  Bell,
  UserCircle,
  Mail,
  User,
  Edit2,
  Check,
  X,
  Upload,
  Loader2,
} from "lucide-react"

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { signOut, updateUser } from "@/lib/actions/auth-action"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"
import { getInitials } from "@/lib/utils/strings"

interface UserProfileDialogProps {
  user: {
    name: string
    email: string
    avatar: string
  }
  open: boolean
  onOpenChange: (open: boolean) => void
  onProfileUpdated?: (name: string, image: string) => void
}

export function UserProfileDialog({
  user,
  open,
  onOpenChange,
  onProfileUpdated,
}: UserProfileDialogProps) {
  const router = useRouter()
  const [isEditing, setIsEditing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [editedName, setEditedName] = useState(user.name)
  const [editedAvatar, setEditedAvatar] = useState(user.avatar)
  const [previewImage, setPreviewImage] = useState<string | null>(null)

  const handleSignOut = async () => {
    try {
      await signOut();
      toast.success("Signed out successfully");
      router.push("/client/login");
    } catch (error) {
      console.error("Sign out error:", error);
      toast.error("Failed to sign out. Please try again.");
    }
  };

  const handleSaveProfile = async () => {
    if (!editedName.trim()) {
      toast.error("Name cannot be empty");
      return;
    }

    setIsSaving(true);
    try {
      const result = await updateUser({
        name: editedName.trim(),
        image: editedAvatar,
      });

      if (result) {
        toast.success("Profile updated successfully");
        onProfileUpdated?.(editedName.trim(), editedAvatar);
        setIsEditing(false);
        setPreviewImage(null);
        router.refresh();
      } else {
        throw new Error("Failed to update profile");
      }
    } catch (error) {
      console.error("Update profile error:", error);
      toast.error("Failed to update profile. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setEditedName(user.name);
    setEditedAvatar(user.avatar);
    setPreviewImage(null);
    setIsEditing(false);
  };

  const handleDialogChange = (open: boolean) => {
    onOpenChange(open);
    if (!open) {
      setIsEditing(false);
      setEditedName(user.name);
      setEditedAvatar(user.avatar);
      setPreviewImage(null);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const validTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"];
    if (!validTypes.includes(file.type)) {
      toast.error("Please upload a valid image file (JPEG, PNG, WebP, or GIF)");
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast.error("File size must be less than 5MB");
      return;
    }

    const reader = new FileReader();
    reader.onloadend = () => {
      setPreviewImage(reader.result as string);
    };
    reader.onerror = () => toast.error("Failed to read image file");
    reader.readAsDataURL(file);

    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("avatar", file);

      const response = await fetch("/api/upload/avatar", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Upload failed");
      }

      const data = await response.json();
      setEditedAvatar(data.url);
      toast.success("Image uploaded successfully");
    } catch (error) {
      console.error("Upload error:", error);
      toast.error("Failed to upload image. Please try again.");
      setPreviewImage(null);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleDialogChange}>
      <DialogContent className="sm:max-w-md bg-white/5 border border-white/10 backdrop-blur-[24px] [-webkit-backdrop-filter:blur(24px)]">
        <DialogHeader>
          <DialogTitle className="text-xl font-bold tracking-tight">Profile</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {isEditing ? "Update your account information" : "Your account information"}
          </DialogDescription>
        </DialogHeader>

        {isEditing ? (
          <div className="flex flex-col gap-6 py-4">
            <div className="flex flex-col items-center gap-4">
              <div className="relative group">
                <input
                  type="file"
                  id="avatar-upload-dialog"
                  accept="image/jpeg,image/jpg,image/png,image/webp,image/gif"
                  onChange={handleFileChange}
                  disabled={isUploading}
                  className="hidden"
                />
                <label
                  htmlFor="avatar-upload-dialog"
                  className="cursor-pointer"
                >
                  <Avatar className="h-28 w-28 ring-2 ring-primary/20 ring-offset-2 ring-offset-zinc-950 transition-all hover:ring-primary/50">
                    <AvatarImage
                      src={previewImage || editedAvatar}
                      alt={editedName}
                      className="object-cover"
                    />
                    <AvatarFallback className="text-3xl bg-zinc-900">{getInitials(editedName)}</AvatarFallback>
                  </Avatar>
                  <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity">
                    {isUploading ? (
                      <Loader2 className="h-8 w-8 text-white animate-spin" />
                    ) : (
                      <Upload className="h-8 w-8 text-white" />
                    )}
                  </div>
                </label>
              </div>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground/60 text-center">
                Click to upload • Max 5MB
              </p>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name" className="text-xs uppercase tracking-widest text-muted-foreground/80 font-semibold">Full Name</Label>
                <Input
                  id="name"
                  placeholder="John Doe"
                  value={editedName}
                  onChange={(e) => setEditedName(e.target.value)}
                  className="bg-zinc-900/50 border-white/5 focus-visible:ring-primary/20"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-widest text-muted-foreground/80 font-semibold">Email Address</Label>
                <Input
                  value={user.email}
                  disabled
                  className="bg-zinc-900/30 border-white/5 text-muted-foreground/50"
                />
                <p className="text-[10px] text-muted-foreground/40 italic">Email cannot be changed</p>
              </div>
            </div>

            <div className="flex gap-3 pt-2">
              <Button
                variant="outline"
                onClick={handleCancelEdit}
                disabled={isSaving || isUploading}
                className="flex-1 border-white/5 hover:bg-white/5"
              >
                Cancel
              </Button>
              <Button
                onClick={handleSaveProfile}
                disabled={isSaving || isUploading}
                className="flex-[2] bg-primary hover:bg-primary/90 text-primary-foreground font-bold"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Check className="mr-2 h-4 w-4" />
                    Save Changes
                  </>
                )}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-8 py-6">
            <Avatar className="h-28 w-28 ring-4 ring-white/5">
              <AvatarImage src={user.avatar} alt={user.name} className="object-cover" />
              <AvatarFallback className="text-3xl bg-zinc-900">{getInitials(user.name)}</AvatarFallback>
            </Avatar>
            
            <div className="flex flex-col items-center gap-1.5 text-center">
              <h3 className="text-2xl font-black tracking-tight">{user.name}</h3>
              <p className="text-sm text-muted-foreground font-medium">{user.email}</p>
            </div>

            <div className="flex flex-col gap-3 w-full">
              <Button
                variant="outline"
                onClick={() => setIsEditing(true)}
                className="w-full h-11 border-white/5 bg-white/[0.02] hover:bg-white/5 transition-all flex items-center justify-center gap-3 font-bold"
              >
                <Edit2 className="h-4 w-4 text-primary" />
                Edit Profile
              </Button>
              <Button
                variant="destructive"
                onClick={handleSignOut}
                className="w-full h-11 bg-red-500/10 hover:bg-red-500/20 text-white border border-red-500/20 transition-all flex items-center justify-center gap-3 font-bold"
              >
                <LogOut className="h-4 w-4" />
                Sign Out
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
