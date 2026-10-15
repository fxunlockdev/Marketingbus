ALTER TABLE "BrandAsset" DROP CONSTRAINT "BrandAsset_bytes_check";
ALTER TABLE "BrandAsset" ADD CONSTRAINT "BrandAsset_bytes_check" CHECK (
 ("status" = 'DELETED' AND "bytes" = 0) OR ("status" <> 'DELETED' AND "bytes" > 0 AND "bytes" <= 5242880)
);
