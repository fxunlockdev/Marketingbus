import { configuredModels, assertExecutionEnabled } from "../production/router";
import { selfHostedScraperBase } from "../knowledge/service";
import { emailConfiguration } from "../identity/service";
export function providerReadiness(){
 let models:ReturnType<typeof configuredModels>=[];let enabled=false;
 try{models=configuredModels().filter(m=>new Date(m.verifiedUntil).getTime()>Date.now());assertExecutionEnabled();enabled=true;}catch{/* Status never exposes secrets or configuration contents. */}
 const reasoning = [
  {id:"openai",name:"OpenAI",role:"Strategy and structured copy",configured:!!(process.env.OPENAI_API_KEY&&(process.env.OPENAI_MODEL||models.some(m=>m.provider==="openai")))},
  {id:"anthropic",name:"Claude",role:"Creative copy and revisions",configured:!!(process.env.ANTHROPIC_API_KEY&&(process.env.ANTHROPIC_MODEL||models.some(m=>m.provider==="anthropic")))},
  {id:"gemini",name:"Gemini",role:"Reference-led brand imagery",configured:!!(process.env.GEMINI_API_KEY&&process.env.GEMINI_IMAGE_MODEL)},
  {id:"higgsfield",name:"Higgsfield",role:"Generated footage and media",configured:!!(process.env.HIGGSFIELD_API_KEY&&process.env.HIGGSFIELD_API_SECRET)}
].map(p=>{
 const implemented=["openai","anthropic"].includes(p.id);
 const executionEnabled=implemented&&p.configured&&enabled&&models.some(m=>m.provider===p.id);
 return {...p,executionEnabled,status:!implemented ? "Production integration unfinished" : executionEnabled ? "Copy enabled · worker required" : p.configured ? "Configured · execution gated" : "Not configured",requirement:implemented ? "Requires a verified model/rate card, matching worker and live integration test." : "Keys alone do not activate production. Image/video workflows still need implementation and live validation."};
});
 let scraper=false, email=false;try{selfHostedScraperBase();scraper=true;}catch{}try{emailConfiguration();email=true;}catch{}
 return [...reasoning,
 {id:"firecrawl",name:"Firecrawl",role:"Self-hosted, single-page website evidence intake",configured:scraper,executionEnabled:scraper,status:scraper?"Private intake enabled · worker required":"Self-hosted intake disabled",requirement:"Requires a deployed private scraper with verified public-web-only egress. Imported evidence needs your review."},
 {id:"resend",name:"Resend",role:"Email verification and password recovery",configured:email,executionEnabled:email,status:email?"Email queue enabled · worker required":"Email delivery disabled",requirement:"Requires a verified sender, API key, encryption keys and live delivery verification. Provider acceptance is not inbox delivery."}];}
export type ProviderReadiness=ReturnType<typeof providerReadiness>;
