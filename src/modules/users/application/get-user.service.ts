import { AppError } from "../../../core/errors/app-error";
import type { User } from "../domain/user";
import type { UserRepository } from "../domain/user.repository";

export class GetUserService {
  constructor(private readonly repository: UserRepository) {}

  async execute(id: string): Promise<User> {
    const user = await this.repository.findById(id.toLowerCase());
    if (!user) {
      throw new AppError("NOT_FOUND", "User not found", 404);
    }
    return user;
  }
}
