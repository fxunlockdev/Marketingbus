import { z } from "zod";
const responseSchema=z.object({id:z.string(),status:z.literal("completed"),usage:z.unknown(),output:z.array(z.object({type:z.string(),content:z.array(z.object({type:z.string(),text:z.string().optional()})).optional()}))});
const claudeSchema=z.object({id:z.string(),stop_reason:z.literal("end_turn"),usage:z.unknown(),content:z.array(z.object({type:z.string(),text:z.string().optional()}))});
type ReasoningInput={system:string;input:string;model:string;maxOutputTokens:number;jsonSchema?:Record<string,unknown>};
// No automatic fallback/retry: a timeout may already have incurred cost. Workers must reconcile/record attempts first.
export async function reason(provider:"openai"|"anthropic",input:ReasoningInput,apiKey:string,transport:typeof fetch=fetch){
 if(!apiKey||!input.model)throw Error("Provider key and exact model must be configured");
 if(input.maxOutputTokens<1||input.maxOutputTokens>8000)throw Error("Invalid token budget");
 if(input.system.length+input.input.length>150000)throw Error("Context budget exceeded");
 const openai=provider==="openai";
 const response=await transport(openai?"https://api.openai.com/v1/responses":"https://api.anthropic.com/v1/messages",{
  method:"POST",headers:openai?{"Content-Type":"application/json",Authorization:`Bearer ${apiKey}`}:{"Content-Type":"application/json","x-api-key":apiKey,"anthropic-version":"2023-06-01"},
  body:JSON.stringify(openai?{model:input.model,instructions:input.system,input:input.input,max_output_tokens:input.maxOutputTokens,store:false,service_tier:"default",...(input.jsonSchema?{text:{format:{type:"json_schema",name:"marketing_creative",strict:true,schema:input.jsonSchema}}}:{})}:{model:input.model,system:input.system,messages:[{role:"user",content:input.input}],max_tokens:input.maxOutputTokens}),signal:AbortSignal.timeout(90000),redirect:"error"
 });
 if(!response.ok)throw Error(`Reasoning provider failed (${response.status})`);
 const raw=await response.text();if(raw.length>2_000_000)throw Error("Provider response exceeded the size limit");
 if(openai){const result=responseSchema.parse(JSON.parse(raw));const text=result.output.flatMap(o=>o.content??[]).filter(c=>c.type==="output_text").map(c=>c.text??"").join("\n");if(!text)throw Error("No usable output");return {id:result.id,text,usage:result.usage};}
 const result=claudeSchema.parse(JSON.parse(raw));const text=result.content.filter(c=>c.type==="text").map(c=>c.text??"").join("\n");if(!text)throw Error("No usable output");return {id:result.id,text,usage:result.usage};
}
