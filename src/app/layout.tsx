import type { Metadata } from "next";
import "./globals.css";
import { AppChrome } from "@/components/chrome";

export const metadata: Metadata = {
  title: "FINQ//DESK — Graph Finance OS",
  description:
    "A FalkorDB-centred multi-agent financial desk: real-time quotes, multi-hop graph reasoning, persistent agent memory, and a company brain. LangGraph + LangChain + MCP.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <AppChrome>{children}</AppChrome>
      </body>
    </html>
  );
}
