import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

type Vector = { x: number; y: number };
interface Rules {
  cols: number; rows: number;
  velocity: (x: number,y: number,deadZone?: number)=>Vector;
  canStand: (x: number,y: number)=>boolean;
  fixture: ()=>Vector;
}
const context = createContext({});
runInContext(readFileSync(resolve('public/miniapps/backyard/rpg-rules.js'),'utf8'), context);
const rules = runInContext('BackyardRpgRules',context) as Rules;
describe('배포 RPG 이동 규칙',()=>{
  it('32×24 지도 시작 fixture는 통행 가능하다',()=>{
    const start=rules.fixture();
    expect([rules.cols,rules.rows]).toEqual([32,24]);
    expect(rules.canStand(start.x,start.y)).toBe(true);
  });
  it('8방향 모두 3초에 288px이며 패드 경계까지 속도가 일정하다',()=>{
    for(let direction=0;direction<8;direction++){
      const angle=direction*Math.PI/4;
      const vector=rules.velocity(Math.cos(angle)*40,Math.sin(angle)*40);
      expect(Math.hypot(vector.x,vector.y)*3).toBeCloseTo(288,8);
    }
    expect(rules.velocity(9,0)).toEqual(rules.velocity(400,0));
  });
  it('8px dead zone와 NaN/Infinity 입력은 정지한다',()=>{
    for(const [x,y] of [[0,0],[8,0],[NaN,10],[Infinity,0]]) expect(rules.velocity(x,y)).toEqual({x:0,y:0});
  });
  it('발 14×10px가 물·줄기·세계 경계 안으로 침범할 수 없다',()=>{
    expect(rules.canStand(633,300)).toBe(true);
    expect(rules.canStand(634,300)).toBe(false);
    expect(rules.canStand(112,272)).toBe(false);
    expect(rules.canStand(22,500)).toBe(false);
    expect(rules.canStand(23,500)).toBe(true);
    expect(rules.canStand(NaN,500)).toBe(false);
  });
});
