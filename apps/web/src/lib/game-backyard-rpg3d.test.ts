/// <reference path="../../public/miniapps/backyard/rpg3d-terrain.js" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

/** 배포 규칙과 지형 모듈을 함께 실행한다. */
function loadTerrain(): { terrain: typeof BackyardRpg3dTerrain; rules: typeof BackyardRpgRules } {
  const context=createContext({});
  for(const name of ['rpg-rules','rpg3d-terrain'])runInContext(readFileSync(resolve(import.meta.dirname,'../../public/miniapps/backyard',name+'.js'),'utf8'),context);
  return {terrain:runInContext('BackyardRpg3dTerrain',context) as typeof BackyardRpg3dTerrain,rules:runInContext('BackyardRpgRules',context) as typeof BackyardRpgRules};
}
describe('3D fixture의 지도 및 접지 계약',()=>{
  it('기존 초기점 및 모든 나무의 논리 위치를 그대로 변환한다',()=>{
    const {terrain,rules}=loadTerrain();
    expect(terrain.toWorld(rules.fixture())).toEqual({x:-8.5,z:6.5});
    expect(rules.trees).toHaveLength(12);
    for(const tree of rules.trees){const point=terrain.toWorld(tree);expect((point.x+16)*32).toBe(tree.x);expect((point.z+12)*32).toBe(tree.y);expect(Number.isFinite(terrain.heightAt(point.x,point.z))).toBe(true);}
  });
  it('33×25 정점, 높이 범위와 인접 경사 제한 및 전체 지도 경계를 지킨다',()=>{
    const {terrain}=loadTerrain();expect(terrain.heights).toHaveLength(825);
    for(let row=0;row<=24;row++)for(let col=0;col<=32;col++){
      const index=row*33+col,h=terrain.heights[index];expect(h).toBeGreaterThanOrEqual(-0.1);expect(h).toBeLessThanOrEqual(0.45);
      expect(terrain.heightAt(col-16,row-12)).toBeCloseTo(h,10);
      if(col<32)expect(Math.abs(h-terrain.heights[index+1])).toBeLessThanOrEqual(0.12);
      if(row<24)expect(Math.abs(h-terrain.heights[index+33])).toBeLessThanOrEqual(0.12);
    }
  });
  it('삼각형 무게중심의 높이가 정점 평균과 같고 공유 대각선에서 연속이다',()=>{
    const {terrain}=loadTerrain();
    for(let row=0;row<24;row++)for(let col=0;col<32;col++){
      const i=row*33+col,a=terrain.heights[i],b=terrain.heights[i+1],c=terrain.heights[i+33],d=terrain.heights[i+34];
      expect(terrain.heightAt(col-16+1/3,row-12+1/3)).toBeCloseTo((a+b+c)/3,10);
      expect(terrain.heightAt(col-16+2/3,row-12+2/3)).toBeCloseTo((b+c+d)/3,10);
      expect(terrain.heightAt(col-16+0.5,row-12+0.5)).toBeCloseTo((b+c)/2,10);
    }
  });
  it('길·집·물 마스크 안의 정점은 평평하다',()=>{
    const {terrain,rules}=loadTerrain();
    for(const rect of [...rules.paths,...rules.water,rules.house])for(let y=Math.ceil(rect.y/32)*32;y<=rect.y+rect.height;y+=32)for(let x=Math.ceil(rect.x/32)*32;x<=rect.x+rect.width;x+=32){const p=terrain.toWorld({x,y});expect(terrain.heightAt(p.x,p.z)).toBe(0);}
  });
  it('비정상 수와 범위 밖 높이 조회를 명확하게 거절한다',()=>{
    const {terrain}=loadTerrain();
    for(const [x,z] of [[NaN,0],[0,Infinity],[-16.01,0],[16.01,0],[0,-12.01],[0,12.01]])expect(()=>terrain.heightAt(x,z)).toThrow(/지도 범위/);
    expect(()=>terrain.toWorld({x:NaN,y:0})).toThrow(/유한한 수/);
  });
});
