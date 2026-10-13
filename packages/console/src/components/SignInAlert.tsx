/* This example requires Tailwind CSS v2.0+ */
import { signIn } from "next-auth/react";
export default function Example() {
  return (
    <button
      type="button"
      onClick={() => signIn()}
      className="rounded-none border-2 px-3 py-2 text-center hover:border-gray-400 focus:outline-none"
    >
      <span className="block font-medium">Sign in to continue</span>
    </button>
  )
}
