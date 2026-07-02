
export function login(username: string, password: string) {
  if (username === "admin" && password === "admin") {
    return { success: true, token: "demo-token" };
  }

  return { success: false, message: "Invalid credentials" };
}
