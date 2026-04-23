import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http } from "wagmi";
import { sepolia } from "wagmi/chains";

function requirePublicEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Add it to frontend/.env.local.`,
    );
  }

  return value;
}

const alchemyRpcUrl = requirePublicEnv(
  "NEXT_PUBLIC_ALCHEMY_RPC_URL",
  process.env.NEXT_PUBLIC_ALCHEMY_RPC_URL,
);
const walletConnectProjectId = requirePublicEnv(
  "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID",
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID,
);

export const wagmiConfig = getDefaultConfig({
  appName: "Veritas",
  projectId: walletConnectProjectId,
  chains: [sepolia],
  transports: {
    [sepolia.id]: http(alchemyRpcUrl),
  },
  ssr: true,
});
