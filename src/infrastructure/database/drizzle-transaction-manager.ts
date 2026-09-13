import type { TransactionManager } from "../../core/transaction/transaction-manager";
import type { Database, DatabaseSession } from "./database";

export type UnitOfWorkFactory<TUnitOfWork> = (session: DatabaseSession) => TUnitOfWork;

export class DrizzleTransactionManager<TUnitOfWork>
  implements TransactionManager<TUnitOfWork>
{
  constructor(
    private readonly database: Database,
    private readonly createUnitOfWork: UnitOfWorkFactory<TUnitOfWork>,
  ) {}

  run<TResult>(operation: (unitOfWork: TUnitOfWork) => Promise<TResult>): Promise<TResult> {
    return this.database.transaction(async (transaction) =>
      operation(this.createUnitOfWork(transaction)),
    );
  }
}
