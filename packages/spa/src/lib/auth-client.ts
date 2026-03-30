import { createAuthClient } from 'better-auth/react'

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'

export const authClient = createAuthClient({
  baseURL: apiUrl,
})

export const { useSession, signIn, signUp, signOut } = authClient
