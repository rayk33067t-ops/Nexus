
export function login(username: string, password: string) {
  if (username === "admin" && password === "admin") {
    return {
      success: true,
      token: "fake-jwt-token",
      user: { username }
    };
  }

  return { success: false, message: "Invalid credentials" };
}
