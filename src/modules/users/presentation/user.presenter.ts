import type { User } from "../domain/user";

export function toUserResponse(user: User) {
  return {
    id: user.id.toLowerCase(),
    email: user.email,
    name: user.name,
    createdAt: user.createdAt.toISOString(),
  };
}
