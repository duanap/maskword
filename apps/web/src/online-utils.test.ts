import { describe, expect, it } from "vitest";
import { buildRoomInviteUrl, extractRoomCode, normalizeRoomCodeInput } from "./online-utils";

describe("online room helpers", () => {
  it("extracts an isolated six-digit room code from shared text", () => {
    expect(extractRoomCode("谁是卧底房间号：455811")).toBe("455811");
    expect(extractRoomCode("加入房间 455811，等你来")).toBe("455811");
    expect(extractRoomCode("房间 1234567")).toBeNull();
    expect(extractRoomCode("没有房间号")).toBeNull();
  });

  it("keeps manual room-code input numeric and bounded", () => {
    expect(normalizeRoomCodeInput("27 73-60")).toBe("277360");
    expect(normalizeRoomCodeInput("谁是卧底房间号：455811")).toBe("455811");
    expect(normalizeRoomCodeInput("1234567")).toBe("123456");
  });

  it("builds a same-origin invitation URL without preserving another path", () => {
    expect(buildRoomInviteUrl("https://maskword.duanap.cn", "455811")).toBe(
      "https://maskword.duanap.cn/?room=455811",
    );
  });
});
