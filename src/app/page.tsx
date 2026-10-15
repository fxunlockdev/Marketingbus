import { redirect } from "next/navigation";
import { session } from "@/lib/auth";
export default async function Home(){redirect(await session()?"/studio":"/login");}
