
export function register(username: string, password: string) {
  return {
    success: true,
    user: { username },
    message: "User registered (mock)"
  };
}
