/**
 * Web requests linked to the server routes that answer them (`Reference.kind: "request"`): a call site with a
 * literal or template path, matched by method and normalised path against the routes the same repository defines.
 */
import { describe, expect, it } from "vitest";
import { indexFiles, refTriples } from "./helpers.js";

const requests = async (files: Record<string, string>) => {
  const { index } = await indexFiles(files);
  const refs = index.refs.filter((r) => r.kind === "request");
  expect(new Set(refs.map((r) => r.resolution))).toEqual(new Set(refs.length ? ["heuristic"] : []));
  return refTriples(index, "request");
};

describe("web requests to server routes", () => {
  it("TS: fetch and axios calls reach Express handlers, through a router mounted under a prefix", async () => {
    expect(
      await requests({
        "server/app.ts": [
          'import express from "express";',
          'import orders from "./orders";',
          "const app = express();",
          'app.use("/api/orders", orders);',
          'app.get("/health", (req, res) => res.send("ok"));',
        ].join("\n"),
        "server/orders.ts": [
          'import { Router } from "express";',
          "const router = Router();",
          "export function listOrders(req, res) {}",
          "export function getOrder(req, res) {}",
          "export function latestOrder(req, res) {}",
          'router.get("/", listOrders);',
          'router.get("/latest", latestOrder);',
          'router.get("/:id", getOrder);',
          'router.post("/", (req, res) => {});',
          "export default router;",
        ].join("\n"),
        "web/api.ts": [
          'import axios from "axios";',
          'export function loadOrders() { return fetch("/api/orders?limit=10"); }',
          "export function loadOrder(id: string) { return axios.get(`/api/orders/${id}`); }",
          'export function loadLatest() { return axios.get("/api/orders/latest"); }',
          'export function createOrder(o) { return fetch("http://localhost:3000/api/orders/", { method: "POST", body: o }); }',
          "export function ping() { return fetch(`${BASE}/health`); }",
          'export function other() { return fetch("https://api.github.com/api/orders"); }',
          'export function wrongMethod() { return axios.delete("/api/orders"); }',
        ].join("\n"),
      }),
    ).toEqual([
      "web/api.ts#loadOrders -> server/orders.ts#listOrders (request)",
      "web/api.ts#loadOrder -> server/orders.ts#getOrder (request)",
      "web/api.ts#loadLatest -> server/orders.ts#latestOrder (request)",
      "web/api.ts#createOrder -> server/orders.ts# (request)",
      "web/api.ts#ping -> server/app.ts# (request)",
    ]);
  });

  it("a path built on a string constant of its file is read through it; a single-page catch-all answers nothing", async () => {
    // As in a FastAPI backend serving a Next.js export: the fallback route returns index.html for any path.
    expect(
      await requests({
        "backend/main.py": [
          "from fastapi import FastAPI",
          "from routes.chat import router as chat_router",
          "app = FastAPI()",
          "app.include_router(chat_router)",
          '@app.get("/{full_path:path}")',
          "def serve_spa(full_path: str):",
          "    return full_path",
        ].join("\n"),
        "backend/routes/chat.py": [
          "from fastapi import APIRouter",
          'router = APIRouter(prefix="/api/chat")',
          '@router.get("/greeting")',
          "def greeting():",
          "    return 1",
          '@router.post("/message")',
          "def message():",
          "    return 2",
        ].join("\n"),
        "frontend/chatApi.ts": [
          "const API_BASE = '/api/chat';",
          "export function getGreeting() { return fetch(`${API_BASE}/greeting`); }",
          'export function sendMessage(m) { return fetch(`${API_BASE}/message`, { method: "POST", body: m }); }',
          "export function missing() { return fetch('/api/nothing/here'); }",
        ].join("\n"),
      }),
    ).toEqual([
      "frontend/chatApi.ts#getGreeting -> backend/routes/chat.py#greeting (request)",
      "frontend/chatApi.ts#sendMessage -> backend/routes/chat.py#message (request)",
    ]);
  });

  it("TS: Next.js route files and pages/api handlers answer fetch calls and SWR keys", async () => {
    expect(
      await requests({
        "app/api/orders/[id]/route.ts": [
          "export async function GET(req: Request) { return Response.json({}); }",
          "export async function DELETE(req: Request) { return new Response(null); }",
        ].join("\n"),
        "app/(shop)/api/cart/route.ts": "export const POST = async () => new Response(null);",
        "pages/api/users/index.ts": "export default function handler(req, res) { res.json([]); }",
        "components/Order.tsx": [
          'import useSWR from "swr";',
          "export function Order({ id }) {",
          "  const { data } = useSWR(`/api/orders/${id}`, fetcher);",
          '  const remove = () => fetch(`/api/orders/${id}`, { method: "DELETE" });',
          '  const add = () => fetch("/api/cart", { method: "POST" });',
          '  const users = () => fetch("/api/users");',
          "  return null;",
          "}",
        ].join("\n"),
      }),
    ).toEqual([
      "components/Order.tsx#Order -> app/api/orders/[id]/route.ts#GET (request)",
      "components/Order.tsx#Order.remove -> app/api/orders/[id]/route.ts#DELETE (request)",
      "components/Order.tsx#Order.add -> app/(shop)/api/cart/route.ts#POST (request)",
      "components/Order.tsx#Order.users -> pages/api/users/index.ts#handler (request)",
    ]);
  });

  it("Python: requests and httpx calls reach FastAPI and Flask handlers, router and blueprint prefixes included", async () => {
    expect(
      await requests({
        "api/items.py": [
          "from fastapi import APIRouter",
          'router = APIRouter(prefix="/items")',
          '@router.get("/{item_id}")',
          "def read_item(item_id: int):",
          "    return {}",
        ].join("\n"),
        "api/main.py": [
          "from fastapi import FastAPI",
          "from api.items import router as items_router",
          "app = FastAPI()",
          'app.include_router(items_router, prefix="/api")',
        ].join("\n"),
        "users/views.py": [
          "from flask import Blueprint",
          'bp = Blueprint("users", __name__, url_prefix="/users")',
          '@bp.route("/<int:uid>", methods=["DELETE"])',
          "def delete_user(uid):",
          '    return ""',
        ].join("\n"),
        "client.py": [
          "import requests, httpx",
          "def fetch_item(item_id):",
          '    return requests.get(f"http://localhost:8000/api/items/{item_id}")',
          "def remove_user(uid):",
          '    return httpx.delete(f"/users/{uid}")',
          "def wrong(uid):",
          '    return httpx.get(f"/users/{uid}")',
        ].join("\n"),
      }),
    ).toEqual([
      "client.py#fetch_item -> api/items.py#read_item (request)",
      "client.py#remove_user -> users/views.py#delete_user (request)",
    ]);
  });

  it("Go: net/http clients reach net/http, gin and chi handlers, groups and sub-routes included", async () => {
    expect(
      await requests({
        "server/main.go": [
          "package main",
          'import "net/http"',
          "func getOrder(w http.ResponseWriter, r *http.Request) {}",
          "func main() {",
          "\tmux := http.NewServeMux()",
          '\tmux.HandleFunc("GET /orders/{id}", getOrder)',
          "}",
        ].join("\n"),
        "server/gin.go": [
          "package main",
          'import "github.com/gin-gonic/gin"',
          "func createOrder(c *gin.Context) {}",
          "func routes() {",
          "\tr := gin.Default()",
          '\tapi := r.Group("/api")',
          '\tapi.POST("/orders", createOrder)',
          "}",
        ].join("\n"),
        "server/chi.go": [
          "package main",
          'import "github.com/go-chi/chi/v5"',
          "func getUser(w http.ResponseWriter, r *http.Request) {}",
          "func chiRoutes(r chi.Router) {",
          '\tr.Route("/v1", func(r chi.Router) {',
          '\t\tr.Get("/users/{id}", getUser)',
          "\t})",
          "}",
        ].join("\n"),
        "client/client.go": [
          "package client",
          'import ("fmt"; "net/http")',
          'func Order(id string) { http.Get("http://localhost:8080/orders/" + id) }',
          'func Create() { http.NewRequest(http.MethodPost, "/api/orders", nil) }',
          'func User(id string) { http.Get(fmt.Sprintf("/v1/users/%s", id)) }',
          'func Wrong() { http.Get("/api/orders") }',
        ].join("\n"),
      }),
    ).toEqual([
      "client/client.go#Order -> server/main.go#getOrder (request)",
      "client/client.go#Create -> server/gin.go#createOrder (request)",
      "client/client.go#User -> server/chi.go#getUser (request)",
    ]);
  });
});
