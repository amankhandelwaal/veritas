"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";

export function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
          <div className="h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_16px_2px_rgba(52,211,153,0.65)]" />
          <span className="text-base font-semibold tracking-wide text-zinc-100 sm:text-lg">
            Veritas
          </span>
        </div>

        <ConnectButton chainStatus="icon" showBalance={false} />
      </div>
    </header>
  );
}
