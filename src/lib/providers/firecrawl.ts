import { z } from "zod";
import { validatePublicDns } from "./url-policy";
const resultSchema=z.object({success:z.literal(true),data:z.object({markdown:z.string().max(200_000).optional(),branding:z.record(z.string(),z.unknown()).optional(),metadata:z.object({sourceURL:z.string().optional(),statusCode:z.number()}).passthrough()})});
// Adapter only: not wired to a customer endpoint until reservations and provider-cost reconciliation are integrated.
export async function scrapeBrand(input:string,apiKey:string,transport:typeof fetch=fetch){
 const url=await validatePublicDns(input);
 if(!apiKey)throw Error("Firecrawl is not configured");
 const response=await transport("https://api.firecrawl.dev/v2/scrape",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${apiKey}`},body:JSON.stringify({url:url.href,formats:["markdown","branding"],onlyMainContent:true,timeout:30000}),signal:AbortSignal.timeout(45000),redirect:"error"});
 if(!response.ok)throw Error(`Firecrawl request failed (${response.status})`);
 const raw=await response.text();if(raw.length>1_000_000)throw Error("Extraction response exceeded the size limit");
 const result=resultSchema.parse(JSON.parse(raw));
 if((result.data.metadata.statusCode<200||result.data.metadata.statusCode>=300)&&result.data.metadata.statusCode!==304)throw Error("The website did not load successfully");
 // Validate final source too; remote crawler redirects must additionally be constrained by the provider contract before enabling.
 if(result.data.metadata.sourceURL)await validatePublicDns(result.data.metadata.sourceURL);
 return {sourceUrl:url.href,retrievedAt:new Date().toISOString(),verified:false,markdown:result.data.markdown??"",branding:result.data.branding??{}};
}
