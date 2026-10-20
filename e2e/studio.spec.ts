import {test,expect} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const password="Test-only-password-2026!";
test("create account, onboard a business, plan, remember and sign out",async({page})=>{
 await page.goto("/login");await page.getByRole("button",{name:"New here? Create an account"}).click();
 await page.getByLabel("Your name").fill("Pilot Tester");await page.getByLabel("Email address").fill(`pilot-${Date.now()}@example.test`);await page.getByLabel("Password",{exact:true}).fill(password);await page.getByRole("button",{name:"Create my account"}).click();await expect(page).toHaveURL(/\/studio/);
 await expect(page.getByRole("heading",{name:"Let’s start with your website."})).toBeVisible();
 await expect(page.getByLabel("Business name",{exact:true})).toHaveCount(0);
 await page.getByLabel("Your website",{exact:true}).fill("www.example.com");await page.getByLabel("This is my business,",{exact:false}).check();
 await page.getByRole("button",{name:"Continue",exact:true}).click();await expect(page.getByRole("heading",{name:"A little more about your brand."})).toBeVisible();
 await page.reload();await expect(page.getByRole("heading",{name:"A little more about your brand."})).toBeVisible();
 await page.getByLabel("No, help me make one",{exact:true}).check();
 await page.getByRole("button",{name:"Review my brand",exact:true}).click();
 await page.getByLabel("Business name",{exact:true}).fill("Forma Architecture");
 await page.getByLabel("What do you do?").fill("Residential architecture and interior design consultations.");await page.getByLabel("Who is it for?").fill("Homeowners building considered spaces.");await page.getByLabel("Your main goal").selectOption("Get more enquiries");
 expect((await new AxeBuilder({page}).include("#main-content").withTags(["wcag2a","wcag2aa","wcag21aa"]).analyze()).violations).toEqual([]);
 const downloadPromise=page.waitForEvent("download");await page.getByRole("button",{name:"Download draft brand book"}).click();expect((await downloadPromise).suggestedFilename()).toBe("brand-book.html");
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.getByRole("button",{name:"Finish setup"}).scrollIntoViewIfNeeded();await expect(page.getByRole("button",{name:"Finish setup"})).toBeInViewport();
 await page.screenshot({path:"../outputs/marketingbus-setup-review.png",fullPage:true});
 await page.getByLabel("These details are correct.").check();await page.getByRole("button",{name:"Finish setup"}).click();
 await expect(page.getByRole("heading",{name:"Introduce your point of view"})).toBeVisible();await page.setViewportSize({width:1280,height:900});
 await page.getByRole("button",{name:"Memory",exact:true}).click();await page.getByLabel("What should this brand always remember?").fill("Use warm, practical language. Never invent project results.");await page.getByRole("button",{name:"Save brand preference"}).click();await expect(page.getByText("Use warm, practical language. Never invent project results.",{exact:true})).toBeVisible();
 await page.getByRole("button",{name:"Connections",exact:true}).click();
 await expect(page.getByRole("heading",{name:"Publishing destinations",exact:true})).toBeVisible();
 for(const channel of ["Instagram","Facebook","LinkedIn"]){await expect(page.getByRole("button",{name:`Connect ${channel}`,exact:true})).toBeDisabled();}
 await expect(page.getByText("No accounts connected for this business.",{exact:true})).toBeVisible();
 await expect(page.getByText("X and YouTube are planned destinations and are not available yet.",{exact:true})).toBeVisible();
 for(const provider of ["OpenAI","Claude","Gemini","Higgsfield","Firecrawl","Resend"]){await expect(page.getByRole("heading",{name:provider,exact:true})).toHaveCount(0);}
 await expect(page.getByText("Provider keys stay on the server.",{exact:false})).toHaveCount(0);
 await page.getByRole("button",{name:"Overview",exact:true}).click();await page.screenshot({path:"../outputs/marketingbus-desktop.png",fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:"../outputs/marketingbus-mobile.png",fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.getByRole("button",{name:"Sign out"}).click();await expect(page).toHaveURL(/\/login/);await page.goto("/studio");await expect(page).toHaveURL(/\/login/);
});
test("unauthenticated and cross-origin writes are rejected",async({request})=>{
 const denied=await request.post("/api/businesses",{headers:{Origin:"http://127.0.0.1:3000"},data:{name:"Bad"}});expect(denied.status()).toBe(401);
 const crossOrigin=await request.post("/api/auth/login",{headers:{Origin:"https://other.example"},data:{email:"x@example.test",password}});expect(crossOrigin.status()).toBe(403);
});
test("two tenants cannot read or mutate each other's business",async({playwright})=>{
 const a=await playwright.request.newContext({baseURL:"http://127.0.0.1:3000",extraHTTPHeaders:{Origin:"http://127.0.0.1:3000"}}),b=await playwright.request.newContext({baseURL:"http://127.0.0.1:3000",extraHTTPHeaders:{Origin:"http://127.0.0.1:3000"}});
 for(const [i,c] of [a,b].entries()){const r=await c.post("/api/auth/register",{data:{name:`Tenant ${i}`,email:`tenant-${i}-${Date.now()}@example.test`,password}});expect(r.ok()).toBe(true);}
 const created=await a.post("/api/businesses",{data:{name:"Private Alpha",offering:"Private service",audience:"Private audience",goal:"Private campaign"}});expect(created.ok()).toBe(true);const {id}=await created.json();
 const cross=await b.post(`/api/businesses/${id}`,{data:{action:"memory",text:"Cross tenant attack"}});expect(cross.status()).toBe(404);
 const bPage=await b.get("/studio");expect(await bPage.text()).not.toContain("Private Alpha");
 const stale=await a.post(`/api/businesses/${id}`,{data:{action:"confirm",version:999}});expect(stale.status()).toBe(409);
 await a.dispose();await b.dispose();
});
