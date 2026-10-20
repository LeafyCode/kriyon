import { createRouter } from "@tanstack/react-router";
import { NotFound } from "./components/NotFound.tsx";
import { routeTree } from "./routeTree.gen.ts";

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultNotFoundComponent: NotFound,
  });
}
