const assert = require("node:assert/strict");
const express = require("express");
const { once } = require("node:events");
const test = require("node:test");
const { createErrorHandler } = require("../src/app");

function runErrorHandler(error) {
  const response = {
    statusCode: null,
    body: null,
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...values) => logged.push(values);
  try {
    createErrorHandler()(error, {}, response, (forwardedError) => {
      throw forwardedError;
    });
  } finally {
    console.error = originalConsoleError;
  }
  return { response, logged };
}

test("unexpected failures return a generic response and log no error message or SQL details", () => {
  const error = new Error("SELECT * FROM users with password=private-test-marker");
  error.code = "ER_ACCESS_DENIED_ERROR";

  const { response, logged } = runErrorHandler(error);

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, {
    message: "Something went wrong. Please try again.",
  });
  assert.equal(JSON.stringify(response.body).includes("private-test-marker"), false);
  assert.equal(JSON.stringify(response.body).includes("SELECT"), false);
  assert.equal(JSON.stringify(logged).includes("private-test-marker"), false);
  assert.equal(JSON.stringify(logged).includes("SELECT"), false);
  assert.equal(JSON.stringify(logged).includes("ER_ACCESS_DENIED_ERROR"), true);
});

test("unexpected HTTP failures return controlled JSON without internal details", async () => {
  const app = express();
  app.get("/unexpected", (req, res, next) => {
    next(new Error("SQL private-http-marker"));
  });
  app.use(createErrorHandler());
  const server = app.listen(0);
  await once(server, "listening");
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/unexpected`);
    const body = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(body, { message: "Something went wrong. Please try again." });
    assert.equal(JSON.stringify(body).includes("private-http-marker"), false);
    assert.equal(JSON.stringify(body).includes("SQL"), false);
  } finally {
    console.error = originalConsoleError;
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("expected request errors use safe, actionable messages and preserve their status", () => {
  const error = new Error("Internal parser details");
  error.status = 400;

  const { response, logged } = runErrorHandler(error);

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, {
    message: "Invalid request. Check the submitted data and try again.",
  });
  assert.deepEqual(logged, []);
});

test("oversized request bodies return a controlled validation error", () => {
  const error = new Error("Parser details");
  error.type = "entity.too.large";

  const { response, logged } = runErrorHandler(error);

  assert.equal(response.statusCode, 413);
  assert.deepEqual(response.body, { message: "Request body is too large." });
  assert.deepEqual(logged, []);
});
