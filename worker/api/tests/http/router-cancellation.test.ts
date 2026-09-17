import { expect, it } from 'vitest';
import { HttpBoundaryError } from '../../src/http/errors';
import { routeRequest } from '../../src/http/router';
import { makeHarness, makeRequest, searchInput } from './router-fixtures';

const deferred = <T>() => {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  if (resolve === undefined) throw new Error('Promise executor did not initialize');
  return { promise, resolve };
};

it('notifies an in-flight Worker adapter immediately when the HTTP request is aborted', async () => {
  const controller = new AbortController();
  const entered = deferred<void>();
  const notified = deferred<boolean>();
  const harness = makeHarness();
  const request = makeRequest('/v1/search', {
    method: 'POST',
    json: searchInput,
    signal: controller.signal,
  });
  const response = routeRequest(request, {
    ...harness.config,
    handlers: {
      ...harness.config.handlers,
      application: {
        handle(_operation, context) {
          return new Promise((_resolve, reject) => {
            context.signal.addEventListener(
              'abort',
              () => {
                notified.resolve(context.cancellation.isCancelled());
                reject(new HttpBoundaryError({ status: 409, code: 'CANCELLED' }));
              },
              { once: true },
            );
            entered.resolve();
          });
        },
      },
    },
  });
  await entered.promise;
  controller.abort();
  expect(await notified.promise).toBe(true);
  expect((await response).status).toBe(409);
});
