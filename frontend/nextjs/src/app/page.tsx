import { redirect } from "next/navigation"
import { auth } from "@/pia-auth"

export default async function IndexPage() {
  const session = await auth()
  
  if (!session || !session.user) {
    redirect("/login")
  }
  
  redirect("/dashboard")
}
