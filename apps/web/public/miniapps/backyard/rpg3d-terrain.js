// @ts-check
/** 저장·DOM 없이 기존 지도에서 높이맵과 삼각형 접지 높이를 생성한다. */
var BackyardRpg3dTerrain = (() => {
  const rules = BackyardRpgRules;
  /** 논리 픽셀을 3D 평면으로 변환한다. @param {RpgVector} point @returns {{x:number,z:number}} */
  function toWorld(point) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw Error('지도 좌표는 유한한 수여야 합니다');
    return {x:point.x / rules.tile - rules.cols / 2,z:point.y / rules.tile - rules.rows / 2};
  }
  /** 길·집·물 마스크 안은 평탄화하고 경계의 높이는 부드럽게 연결한다. @param {number} x @param {number} z */
  function nodeHeight(x,z) {
    const u=(x+rules.cols/2)*rules.tile,v=(z+rules.rows/2)*rules.tile;
    let distance=Infinity;
    for(const rect of [...rules.paths,...rules.water,rules.house]) {
      distance=Math.min(distance,Math.hypot(Math.max(rect.x-u,0,u-rect.x-rect.width),Math.max(rect.y-v,0,v-rect.y-rect.height))/rules.tile);
    }
    const blend=Math.min(1,distance/3);
    return (0.12+0.09*Math.sin(x*0.24)*Math.cos(z*0.29))*blend*blend*(3-2*blend);
  }
  const heights=Object.freeze(Array.from({length:(rules.cols+1)*(rules.rows+1)},(_,i)=>nodeHeight(i%(rules.cols+1)-rules.cols/2,Math.floor(i/(rules.cols+1))-rules.rows/2)));
  /** 렌더링 삼각형과 같은 대각선을 사용해 발 높이를 보간한다. @param {number} x @param {number} z @returns {number} */
  function heightAt(x,z) {
    if(!Number.isFinite(x)||!Number.isFinite(z)||x < -rules.cols/2 || x > rules.cols/2 || z < -rules.rows/2 || z > rules.rows/2) throw Error('높이 조회가 지도 범위를 벗어났습니다');
    const u=x+rules.cols/2,v=z+rules.rows/2,col=Math.min(rules.cols-1,Math.floor(u)),row=Math.min(rules.rows-1,Math.floor(v));
    const dx=u-col,dz=v-row,index=row*(rules.cols+1)+col;
    const a=heights[index],b=heights[index+1],c=heights[index+rules.cols+1],d=heights[index+rules.cols+2];
    return dx+dz<=1 ? a+(b-a)*dx+(c-a)*dz : d+(c-d)*(1-dx)+(b-d)*(1-dz);
  }
  return Object.freeze({toWorld,heightAt,heights});
})();
