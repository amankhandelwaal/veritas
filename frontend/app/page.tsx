export default function Home() {
  return (
    <section className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_20%,rgba(52,211,153,0.22),transparent_30%),radial-gradient(circle_at_85%_10%,rgba(16,185,129,0.2),transparent_25%),linear-gradient(180deg,rgba(9,12,10,0.98),rgba(5,8,7,1))]" />
      <div className="relative mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-6xl items-center px-4 py-16 sm:px-6 lg:px-8">
        <div className="max-w-3xl space-y-8">
          <div className="inline-flex items-center rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs font-medium tracking-[0.18em] text-emerald-200 uppercase">
            Phase 1 Live
          </div>
          <h1 className="text-4xl font-semibold leading-tight tracking-tight text-zinc-50 sm:text-5xl lg:text-6xl">
            Veritas: decentralized social built for signal over noise.
          </h1>
          <p className="max-w-2xl text-base leading-8 text-zinc-300 sm:text-lg">
            Connect your wallet to enter a censorship-resistant feed where content
            lives off-chain, governance lives on-chain, and moderation is transparent.
          </p>
          <div className="flex flex-wrap items-center gap-3 text-sm text-zinc-300">
            <span className="rounded-md border border-zinc-800 bg-zinc-900/80 px-3 py-1.5">
              Sepolia
            </span>
            <span className="rounded-md border border-zinc-800 bg-zinc-900/80 px-3 py-1.5">
              Events-Only Feed
            </span>
            <span className="rounded-md border border-zinc-800 bg-zinc-900/80 px-3 py-1.5">
              Off-Chain ML Gate
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
