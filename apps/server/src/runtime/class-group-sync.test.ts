import { Buffer } from "node:buffer";
import { describe, expect, test } from "bun:test";
import {
  buildClassGroupForwardNodes,
  buildClassGroupImageSegments,
  formatClassGroupSyncFailure,
  selectPostsToSync,
} from "./class-group-sync";

const card = new Uint8Array([1, 2, 3]);
const photo = { name: "a.jpg", bytes: new Uint8Array([4, 5]) };

describe("class group sync messages", () => {
  test("card goes first, followed by original images, no text", () => {
    expect(buildClassGroupImageSegments({ card, images: [photo] })).toEqual([
      { type: "image", data: { file: `base64://${Buffer.from(card).toString("base64")}` } },
      { type: "image", data: { file: `base64://${Buffer.from(photo.bytes).toString("base64")}` } },
    ]);
    expect(buildClassGroupImageSegments({ card: undefined, images: [] })).toEqual([]);
  });

  test("forward nodes use the bot and wall name as sender, one node per post", () => {
    const nodes = buildClassGroupForwardNodes([{ card, images: [] }, { card, images: [photo] }], { name: "某班校园墙", uin: "10000" });
    expect(nodes).toHaveLength(2);
    expect(nodes.every((node) => node.data.name === "某班校园墙" && node.data.uin === "10000")).toBe(true);
    expect(nodes[1]?.data.content).toHaveLength(2);
    expect(JSON.stringify(nodes)).not.toContain("text");
  });

  test("dedupes by postId across targets, history, and in-flight syncs", () => {
    const posts = [
      { postId: "a", displayId: 1 },
      { postId: "a", displayId: 1 },
      { postId: "b", displayId: 2 },
      { postId: "c", displayId: 3 },
      { postId: "d", displayId: 4 },
    ];
    expect(selectPostsToSync(posts, new Set(["b"]), new Set(["c"])).map((post) => post.postId)).toEqual(["a", "d"]);
  });

  test("failure notice lists the posts and trims long errors", () => {
    expect(formatClassGroupSyncFailure([12, 13], "Bot 不在群里")).toBe("班级群同步失败 #12、#13：Bot 不在群里");
    expect(formatClassGroupSyncFailure([1], "x".repeat(500)).length).toBeLessThan(230);
  });
});
