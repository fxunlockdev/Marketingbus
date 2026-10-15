import { describe,it,expect } from "vitest";
import { brandInput,brandSuggestions,proposePlan } from "../src/lib/brand";
import { assessQuality,compileHarness } from "../src/lib/harness/contracts";
import { reviewDecision } from "../src/lib/review";
import { publicUrl } from "../src/lib/providers/url-policy";
import { reason } from "../src/lib/providers/reasoning";
const brand=brandInput.parse({name:"Example",offering:"Home design services",audience:"Home owners",goal:"Book consultations"});
describe("brand context",()=>{
 it("requires business facts",()=>expect(()=>brandInput.parse({name:"x"})).toThrow());
 it("rejects arbitrary privileged fields",()=>expect(()=>brandInput.parse({...brand,organizationId:"other"})).toThrow());
 it("flags missing proof without making it up",()=>expect(brandSuggestions(brand).map(s=>s.id)).toContain("proof"));
 it("creates honest planning outlines",()=>expect(proposePlan(brand)[0].brief.source).toBe("Profile-based planning template"));
 it("never expands to unrelated channels",()=>expect(proposePlan({...brand,channels:["LinkedIn"]})).toHaveLength(1));
});
describe("specialist harness",()=>{
 const brief={organizationId:"a",businessId:"b",planItemId:"item",brandVersion:1,discipline:"static",objective:"Generate inquiries",audienceTension:"Hard to find a design partner",proposition:"Personal design consultations",evidence:[],concept:"Show the design process",direction:"Use real project references",brand,brandConfirmed:true,creditCeiling:100,preferences:[]};
 it("loads contextual source contracts and Humanizer",async()=>{const compiled=await compileHarness(brief,{organizationId:"a",businessId:"b"});expect(compiled.sourceHashes.map(s=>s.file)).toContain("humanizer.md");expect(compiled.system).toContain("Lock approved logo");expect(compiled.maximumAttempts).toBe(2);});
 it("denies cross-tenant context",async()=>expect(compileHarness(brief,{organizationId:"other",businessId:"b"})).rejects.toThrow("Cross-tenant"));
 it("requires confirmed context",async()=>expect(compileHarness({...brief,brandConfirmed:false},{organizationId:"a",businessId:"b"})).rejects.toThrow());
 it("fails critical defects regardless of score",()=>expect(assessQuality({insight:100,idea:100,brand:100,craft:100,clarity:100,fidelity:100},["invented testimonial"]).eligibleForCustomerReview).toBe(false));
 it("does not treat rubric as percentile",()=>expect(assessQuality({insight:80,idea:80,brand:80,craft:80,clarity:80,fidelity:80},[]).measurement).toContain("not an agency-quality percentile"));
});
describe("review policy",()=>{
 it("rejection incurs no generation or credits",()=>expect(reviewDecision({currentVersion:2,reviewedVersion:2,state:"READY",action:"reject"})).toMatchObject({state:"REJECTED",mayRequestRevisionQuote:false,creditsConsumed:0,generationAuthorized:false}));
 it("stale approval fails",()=>expect(()=>reviewDecision({currentVersion:2,reviewedVersion:1,state:"READY",action:"approve"})).toThrow());
 it("revision requires feedback and revokes pending publication",()=>{expect(()=>reviewDecision({currentVersion:1,reviewedVersion:1,state:"APPROVED",action:"revise"})).toThrow();expect(reviewDecision({currentVersion:1,reviewedVersion:1,state:"APPROVED",action:"revise",feedback:"Fix title"}).revokePendingPublication).toBe(true);});
});
describe("URL controls",()=>{
 for(const url of ["http://example.com","https://127.0.0.1","https://169.254.169.254","https://[::1]","https://user:pass@example.com","https://example.com:9000","https://internal.local","https://2130706433","https://[::ffff:127.0.0.1]"]){it(`blocks ${url}`,()=>expect(()=>publicUrl(url)).toThrow());}
 it("accepts public HTTPS syntax",()=>expect(publicUrl("https://example.com/about#section").href).toBe("https://example.com/about"));
});
describe("provider boundary",()=>{
 it("refuses missing configuration before network calls",async()=>expect(reason("openai",{system:"x",input:"y",model:"",maxOutputTokens:100},"")).rejects.toThrow("configured"));
 it("stores real reported usage and disables provider storage",async()=>{
  const transport:typeof fetch=async (_url,init)=>{expect(JSON.parse(String(init?.body)).store).toBe(false);return Response.json({id:"response-1",status:"completed",usage:{input_tokens:10,output_tokens:5},output:[{type:"message",content:[{type:"output_text",text:"A real result"}]}]});};
  const result=await reason("openai",{system:"x",input:"y",model:"test-model",maxOutputTokens:100},"test-key",transport);expect(result.usage).toEqual({input_tokens:10,output_tokens:5});
 });
 it("does not return incomplete provider output as success",async()=>expect(reason("openai",{system:"x",input:"y",model:"test",maxOutputTokens:100},"key",async()=>Response.json({id:"r",status:"incomplete",usage:{},output:[]}))).rejects.toThrow());
});
