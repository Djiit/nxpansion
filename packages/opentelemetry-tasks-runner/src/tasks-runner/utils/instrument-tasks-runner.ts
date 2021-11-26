import { Context, trace } from '@opentelemetry/api';
import { api, NodeSDK } from '@opentelemetry/sdk-node';
import { defer, Observable } from 'rxjs';
import { switchMap, takeLast, tap } from 'rxjs/operators';
import { requireDynamicModule } from './require-dynamic-module';
import { TaskWithSpan } from '../../plugins/nx-default-tasks-runner-instrumentation';
import { TasksRunnerArgs } from '../../plugins/nx-default-tasks-runner-instrumentation/types/tasks-runner-args.type';
import { VERSION } from '../../version.const';
import { OpentelemetryTasksRunnerOptions } from '../types/opentelemetry-tasks-runner-options.type';
import type {
  AffectedEvent,
  TasksRunner,
} from '@nrwl/workspace/src/tasks-runner/tasks-runner';

/**
 * Wraps the observable in the configured tasks runner in a trace and
 * closes out the spans that are generated by the NxDefaultTasksRunnerInstrumentation.
 * @param otelSdk The sdk to that will be shutdown once all tasks are complete
 * @param context The context to create the root span in
 * @param tasksRunnerArgs The arguments to provide to the wrapped tasks runner
 * @returns An observable that forwards the emitted tasks by the wrapped tasks runner
 */
export function instrumentTasksRunner(
  otelSdk: NodeSDK,
  context: Context,
  tasksRunnerArgs: TasksRunnerArgs<OpentelemetryTasksRunnerOptions<any>>
) {
  const [tasks, options, ctx] = tasksRunnerArgs;
  const tasksWithSpan = tasks as TaskWithSpan[];
  const tasksRunner: TasksRunner = requireDynamicModule(
    options.wrappedTasksRunner
  );
  const tasksRunnerObservable = tasksRunner(
    tasks,
    options.wrappedTasksRunnerOptions,
    ctx
  );
  const tracer = trace.getTracer('@nxpansion/opentelemetry-nx-runner', VERSION);
  return new Observable<AffectedEvent>((o) => {
    const result = tracer.startActiveSpan(
      'nx-command',
      {},
      context,
      async (span) => {
        span.setAttributes({
          'command.target': ctx.target,
          'command.initiatingProject': ctx.initiatingProject,
        });
        tasksWithSpan.forEach((task) => (task.context = api.context.active()));
        await tasksRunnerObservable
          .pipe(
            tap((event: AffectedEvent & { task: TaskWithSpan }) => {
              if (event.task?.span) {
                event.task.span.setAttribute('task.type', event.type);
                event.task.span.end(event.task.endTime);
              }
              o.next(event);
            }),
            takeLast(1),
            switchMap(() =>
              defer(async () => {
                span.end();
                await otelSdk.shutdown();
                o.complete();
              })
            )
          )
          .toPromise();
      }
    );
    result.catch((error) => {
      o.error(error);
    });
  });
}