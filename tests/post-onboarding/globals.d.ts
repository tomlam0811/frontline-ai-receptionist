// Test-only global: the sign-in callback the owner screens receive is recorded on window.
interface Window { __signIn?: boolean }
