export interface BrandDNA {
  name: string;
  tagline: string;
  url: string;
  logoUrl: string | null;
  favicon: string | null;
  ogImage: string | null;
  logos: LogoInfo[];
  colors: ColorInfo[];
  fonts: FontInfo[];
  tone: ToneProfile;
  audience: AudienceProfile;
  industry: string;
  category: string;
  keywords: string[];
  rawText: string;
}

export interface LogoInfo {
  url: string;
  alt: string;
  width?: number;
  height?: number;
}

export interface ColorInfo {
  hex: string;
  name: string;
  usage: "primary" | "secondary" | "accent" | "background" | "text";
  rgb: [number, number, number];
}

export interface FontInfo {
  family: string;
  usage: "heading" | "body" | "accent";
  weight?: string;
}

export interface ToneProfile {
  primary: ToneType;
  secondary: ToneType;
  description: string;
  formality: number; // 0-100
  energy: number; // 0-100
  warmth: number; // 0-100
}

export type ToneType =
  | "formal"
  | "casual"
  | "playful"
  | "professional"
  | "authoritative"
  | "friendly"
  | "inspirational"
  | "technical"
  | "luxurious"
  | "minimalist";

export interface AudienceProfile {
  primary: string;
  secondary: string;
  ageRange: string;
  interests: string[];
  painPoints: string[];
}

export interface CrawlProgress {
  step: string;
  status: "pending" | "running" | "done" | "error";
  detail?: string;
}

export interface BrandAnalysisResult {
  brand: BrandDNA;
  progress: CrawlProgress[];
}
