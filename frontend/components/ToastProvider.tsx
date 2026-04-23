"use client";

import { Toaster } from "sonner";

export function ToastProvider() {
  return (
    <Toaster
      theme="dark"
      richColors
      position="top-right"
      toastOptions={{
        className: "!border !border-zinc-700 !bg-zinc-900 !text-zinc-100",
      }}
    />
  );
}
