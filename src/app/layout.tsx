import type { Metadata } from "next";
import "@fontsource-variable/figtree";
import "./globals.css";
export const metadata:Metadata={title:"Marketingbus — your brand, in motion",description:"A brand-aware creative workspace. Plan, review and improve your marketing.",robots:{index:false,follow:false}};
export default function RootLayout({children}:{children:React.ReactNode}) { return <html lang="en"><body>{children}</body></html>; }
