import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
export function publicUrl(input:string){
 const url=new URL(input);
 if(url.protocol!=="https:"||url.username||url.password||url.port&&url.port!=="443")throw Error("Use a public HTTPS website without credentials or custom ports");
 const host=url.hostname.toLowerCase().replace(/^\[|\]$/g,"");
 if(!host.includes(".")||host.endsWith(".local")||host.endsWith(".internal")||host.endsWith(".localhost"))throw Error("Private website addresses are not allowed");
 if(ipaddr.isValid(host)&&ipaddr.process(host).range()!=="unicast")throw Error("Private website addresses are not allowed");
 url.hash="";return url;
}
export async function validatePublicDns(input:string){
 const url=publicUrl(input);const records=await lookup(url.hostname,{all:true});
 if(!records.length||records.some(r=>ipaddr.process(r.address).range()!=="unicast"))throw Error("Website resolves to a restricted address");
 return url;
}
