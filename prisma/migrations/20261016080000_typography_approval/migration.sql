-- Old approval remains auditable, but cannot authorize newly rendered appearance.
ALTER TABLE "StaticComposition" ADD COLUMN "approvedRendererVersion" TEXT;
