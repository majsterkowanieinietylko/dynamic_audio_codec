/*
    DAC - Dynamic Audio Codec, a lossy audio codec written by MINT: https://www.youtube.com/@__MINT_
    
    This file contains main functions for DAC, comes with absolutely no warranty!
*/

const coreFunctionString = `

let bitPercent = 15;  // parameters being rather constant, so there is no use to pass them every function call
let samplingRate = 44100;
let dynamicRange = 96;
let frequencyRange = 0;
let topBitLimit = 0;
let bottomBitLimit = 0;
let mostImportant = 800;
let transientThreshold = 2.5;
let bandSize = 8;
let keyframeGap = 2;
let adaptiveAllocation = 1;
let highStart = 92;
let highStop = 463;
let noiseFloor = 40000;
let subbandFreq = 344.53125;
let lastLow = 2;
let regionSteps = [dynamicRange - 15, dynamicRange - 25, dynamicRange - 35, dynamicRange - 50];

let savedBits = 0;  // virtual bit reservoir

function binConvert(numb, dSize)
 {
 numb = Math.round(numb);
 if(dSize == 1)
  {
  return [numb & 255];
  }
 let outBytes = [];
 let bitVal = Math.pow(2, dSize * 8);
 if(numb < 0)
  {
  numb += bitVal;
  }
 for(let i=0; i<dSize; i++)
  {
  outBytes.push(numb & 255);
  numb >>= 8;
  }
 return outBytes;
 }

function byteFormat(bitStream, lenData, totalBytes, bit)
 {
 let at = 0;
 let result = new Array(totalBytes).fill(0);
 for(let i=0; i<bitStream.length; i++)
  {
  let val = bitStream[i];
  let len = lenData[i];
  let bytes = Math.ceil((len + bit) / 8);
  let adjust = (bytes << 3) - len - bit;
  result[at + bytes - 1] |= (val << adjust) & 255;
  if(bytes > 1)
   {
   val >>= 8 - adjust;
   result[at + bytes - 2] |= val & 255;
   if(bytes == 3)
    {
    val >>= 8;
    result[at] |= val & 255;
    }
   }
  bit += len;
  at += bit >> 3;
  bit &= 7;
  }
 return result;
 }

function insert(currentBytes, newValue, len, byteCount, bit)
 {
 let adjust = (byteCount << 3) - len - bit;
 currentBytes[byteCount - 1] |= (newValue << adjust) & 255;
 if(byteCount > 1)
  {
  newValue >>= 8 - adjust;
  currentBytes[byteCount - 2] |= newValue & 255;
  }
 if(byteCount == 3)
  {
  newValue >>= 8;
  currentBytes[0] |= newValue & 255;
  }
 return currentBytes;
 }

function createFrame(frameNumb, selChannel, prevHighTones, forceTransient)
 {
 let MDCT = FMDCT(getFrame(frameNumb, selChannel));
 let analyze = dBconvert(MDCT);
 let highContent = analyze.highTones > noiseFloor ? analyze.highTones : noiseFloor;
 let transientDetected = (transientThreshold > 10 || prevHighTones == -1) ? false : (highContent / prevHighTones) > transientThreshold;
 let handleTransient = transientDetected || forceTransient;
 let signalMaskData = bitPercent >= 100 ? getSNR(analyze.magnitudes) : getSMR(analyze.magnitudes, handleTransient);
 let subbandCount = signalMaskData.actualSubbands;
 let allocBits = allocate(signalMaskData.bandMaxes, signalMaskData.absoluteMax, signalMaskData.nonZeroCount, subbandCount);
 let scaled = quantize(MDCT, allocBits.limitedBits, allocBits.allocOrder, allocBits.bitsPerBand, allocBits.bitLimit, signalMaskData.nonZeroCoeffs, subbandCount);
 scaled.transient = transientDetected;
 scaled.high = highContent;
 return scaled;
 }

function dBconvert(coeffs)
 {
 let absVal = new Array(512);
 let highSum = 0;
 for(let i=0; i<512; i++)
  {
  let single = Math.abs(coeffs[i]);
  if(i >= highStart && i <= highStop)
   {
   highSum += single;
   }
  absVal[i] = single;
  }
 let top = Math.max.apply(Math, absVal);
 if(top < 0.001)
  {
  return {magnitudes: absVal.fill(-150), highTones: 0};
  }
 let result = new Array(512);
 let maxMag = -150;
 for(let i=0; i<512; i++)
  {
  let magnitude = absVal[i] == 0 ? 0.001 : absVal[i];
  let dB = 20 * Math.log10(magnitude /* top*/);
  if(dB < -150)
   {
   dB = -150;
   }
  else if(dB > maxMag) maxMag = dB;
  result[i] = dB;// + dynamicRange;
  }
 let exceed = maxMag - dynamicRange;
 if(exceed > 0)
  {
  for(let i=0; i<512; i++)
   {
   result[i] -= exceed;
   }
  }
 return {magnitudes: result, highTones: highSum};
 }
 

function getFrame(which, channel)
 {
 let offset = which * 512 * audioChannels + channel;
 let sliced = new Array(1024);
 let at = offset;
 for(let i=0; i<1024; i++)
  {
  sliced[i] = audioBuffer[at];
  at += audioChannels;
  }
 return sliced;
 }

function getSMR(data, handleTransient)
 {
 let setCutoff = frequencyRange == 0 ? cutoff(bitPercent) : frequencyRange;
 let analyzeRange_1 = freqToCoeff(setCutoff, samplingRate);
 let analyzeRange = analyzeRange_1 + 1;
 let peaks = new Array(analyzeRange);
 let foundTonal = new Array(analyzeRange);
 let foundNoise = new Array(analyzeRange);
 let tonalCount = 0;
 let noiseCount = 0;
 let peakCount = 0;
 let SPL = new Array(analyzeRange);
 let status = new Array(analyzeRange).fill(0);
 for(let i=0; i<analyzeRange; i++)
  {
  SPL[i] = data[i];
  }
 for(let i=1; i<analyzeRange_1; i++)
  {
  if(data[i] >= data[i + 1] && data[i] > data[i - 1])
   {
   peaks[peakCount++] = i;
   }
  }
 for(let i=0; i<peakCount; i++)
  {
  let tonal = true;
  let peakLoc = peaks[i];
  let verifyInd = peakLoc >> 7;
  if(verifyInd > 2){verifyInd = 2;}
  let verifyWidth = verifySizes[verifyInd];
  for(let j=0; j<verifyWidth; j++)
   {
   let check = peakLoc + tonalVerify[verifyInd][j];
   if(check < 0 || check > analyzeRange_1)
    {
	continue;
	}
   if(data[peakLoc] - data[check] < 5)
    {
	tonal = false;
	break;
	}
   }
  if(tonal)
   {
   let near = [-150, data[peakLoc], -150];
   if(peakLoc > 0)
    {
	near[0] = data[peakLoc - 1];
	}
   if(peakLoc < analyzeRange_1)
    {
	near[2] = data[peakLoc + 1];
	}
   let maskerSPL = add_dB(near, 3);
   if(maskerSPL < hearingThreshold(peakLoc, samplingRate))
    {
	continue;
	}
   SPL[peakLoc] = maskerSPL;
   foundTonal[tonalCount++] = peakLoc;
   status[peakLoc] = 1;
   }
  }
 for(let i=0; i<tonalCount; i++)
  {
  let checkTonal = foundTonal[i];
  let SPLcheck = SPL[checkTonal];
  let barkCheck = coeffToBark(checkTonal, samplingRate);
  for(let j=i+1; j<tonalCount; j++)
   {
   let next = foundTonal[j];
   let barkNext = coeffToBark(next, samplingRate);
   if(barkNext - barkCheck >= 0.5)
    {
	break;
	}
   let SPLnext = SPL[next];
   if(SPLcheck > SPLnext)
    {
	status[next] = 0;
	continue;
	}
   status[checkTonal] = 0;
   break;
   }
  if(!status[checkTonal])
   {
   continue;
   }
  let regionWidth = nonMaskSize(SPLcheck, true);
  let regionStart = checkTonal - regionWidth;
  let regionStop = checkTonal + regionWidth;
  for(let j=regionStart; j<regionStop; j++)
   {
   if(j < 0)
    {
	continue;
	}
   if(j > analyzeRange_1)
    {
	break;
	}
   if(SPLcheck - SPL[j] > 40)
    {
	continue;
	}
   if(status[j] != 1)
    {
	status[j] = 2;
	}
   }
  }
 let startCoeff = barkToCoeff(0, samplingRate);
 for(let i=0; i<25; i++)
  {
  let weighted = 0;
  let summed = -150;
  let stopCoeff = barkToCoeff(i + 1, samplingRate);
  if(stopCoeff <= startCoeff)
   {
   stopCoeff = startCoeff + 1;
   }
  for(let j=startCoeff; j<stopCoeff; j++)
   {
   if(status[j] == 1)
    {
	continue;
	}
   summed = add_dB([data[j], summed], 2);
   weighted += Math.pow(10, data[j] / 10) * (coeffToBark(j, samplingRate) - i);
   }
  if(summed > hearingThreshold(startCoeff, samplingRate) + 20)
   {
   let ind = weighted / Math.pow(10, summed / 10);
   let center = startCoeff + parseInt(ind * (stopCoeff - startCoeff));
   if(status[center] == 1)
    {
	center++;
	}
   if(center > analyzeRange_1)
    {
	break;
	}
   status[center] = 3;
   SPL[center] = summed;
   foundNoise[noiseCount++] = center;
   let regionWidth = nonMaskSize(summed, false);
   let regionStart = center - regionWidth;
   let regionStop = center + regionWidth;
   for(let j=regionStart; j<regionStop; j++)
    {
    if(j < 0)
     {
	 continue;
	 }
    if(j > analyzeRange_1)
     {
	 break;
	 }
    if(summed - SPL[j] > 40)
     {
	 continue;
	 }
	if(status[j] != 1 && status[j] != 3)
     {
	 status[j] = 2;
	 }
    }
   }
  if(stopCoeff >= analyzeRange_1)
   {
   break;
   }
  startCoeff = stopCoeff;
  }
 let tonalMaskers = 0;
 let noiseMaskers = 0;
 for(let i=0; i<analyzeRange; i++)
  {
  switch(status[i])
   {
   case 1:
    {
	foundTonal[tonalMaskers++] = i;
	}
   break;
   case 3:
    {
	foundNoise[noiseMaskers++] = i;
	}
   }
  }
 let maskingTonal = new Array(analyzeRange);
 let maskingNoise = new Array(analyzeRange);
 let singleTonal = new Array(tonalMaskers);
 let singleNoise = new Array(noiseMaskers);
 for(let i=0; i<analyzeRange; i++)
  {
  if(status[i])
   {
   maskingTonal[i] = -150;
   maskingNoise[i] = -150;
   continue;
   }
  let maskedBark = coeffToBark(i, samplingRate);
  for(let j=0; j<tonalMaskers; j++)
   {
   let maskerIndex = foundTonal[j];
   let maskerBark = coeffToBark(maskerIndex, samplingRate);
   let diff = maskedBark - maskerBark;
   if(diff < -3 || diff > 8 || (handleTransient && data[maskerIndex] - data[i] < 40))
    {
	singleTonal[j] = -150;
	continue;
	}
   let spreadFactor = -0.275 * maskerBark - 6.025;
   let proxFactor;
   if(diff >= -3 && diff < -1)
	{
	proxFactor = 17 * (diff + 1) - (data[maskerIndex] * 0.4 + 6);
	}
   else if(diff >= -1 && diff < 0)
    {
	proxFactor = diff * (data[maskerIndex] * 0.4 + 6);
	}
   else if(diff >= 0 && diff < 1)
	{
	proxFactor = -17 * diff;
	}
   else
	{
	proxFactor = -(diff - 1) * (17 - data[maskerIndex] * 0.15) - 17;
	}
   singleTonal[j] = data[maskerIndex] + spreadFactor + proxFactor;
   }
  for(let j=0; j<noiseMaskers; j++)
   {
   let maskerIndex = foundNoise[j];
   let maskerBark = coeffToBark(maskerIndex, samplingRate);
   let diff = maskedBark - maskerBark;
   if(diff < -3 || diff > 8 || (handleTransient && data[maskerIndex] - data[i] < 40))
    {
	singleNoise[j] = -150;
	continue;
	}
   let spreadFactor = -0.175 * maskerBark - 2.025;
   let proxFactor;
   if(diff >= -3 && diff < - 1)
	{
	proxFactor = 17 * (diff + 1) - (data[maskerIndex] * 0.4 + 6);
	}
   else if(diff >= -1 && diff < 0)
	{
	proxFactor = diff * (data[maskerIndex] * 0.4 + 6);
	}
   else if(diff >= 0 && diff < 1)
	{
	proxFactor = -17 * diff;
	}
   else
	{
	proxFactor = -(diff - 1) * (17 - data[maskerIndex] * 0.15) - 17;
	}
   singleNoise[j] = data[maskerIndex] + spreadFactor + proxFactor;
   }
  maskingTonal[i] = add_dB(singleTonal, tonalMaskers);
  maskingNoise[i] = add_dB(singleNoise, noiseMaskers);
  }
 let subbands = Math.ceil(analyzeRange / bandSize);
 let SMR = new Array(subbands * bandSize);
 let rejectBelow = SMRreject(bitPercent);
 let limitRange = dynamicLimit(bitPercent);
 let lastNonZero = 0;
 let at = 0;
 for(let i=0; i<subbands; i++)
  {
  let bandMax = -150;
  for(let j=0; j<bandSize; j++)
   {
   if(at > analyzeRange_1)
    {
	SMR[at++] = 0;
	continue;
	}
   let maskers = [maskingTonal[at], maskingNoise[at]];
   let singleThresh = add_dB(maskers, 2);
   let singleSMR = singleThresh > 0 ? data[at] - singleThresh : data[at];
   if(singleSMR > bandMax)
    {
	bandMax = singleSMR;
	}
   SMR[at++] = singleSMR;
   }
  if(bandMax <= 0)
   {
   continue;
   }
  at -= bandSize;
 for(let j=0; j<bandSize; j++)
   {
   let single = SMR[at];
   if(single >= rejectBelow && bandMax - single <= limitRange)
    {
	lastNonZero = at + 1;
	}
   else
    {
	SMR[at] = 0;
	}
   at++;
   }
  }
 let actualSubbands = Math.ceil(lastNonZero / bandSize);
 let nonZeroCoeffs = new Array(actualSubbands * bandSize);
 let bandMaxes = new Array(actualSubbands);
 let nonZeroCount = new Array(actualSubbands);
 at = 0;
 for(let i=0; i<actualSubbands; i++)
  {
  let bandMax = -150;
  let bandNonZero = 0;
  for(let j=0; j<bandSize; j++)
   {
   let single = SMR[at];
   let nonZero = single > 0;
   nonZeroCoeffs[at++] = nonZero;
   if(!nonZero)
    {
	continue;
	}
   bandNonZero++;
   if(single > bandMax)
    {
	bandMax = single;
	}
   }
  nonZeroCount[i] = bandNonZero;
  bandMaxes[i] = bandMax;
  }
 let absoluteMax = Math.max.apply(Math, bandMaxes);
 return {nonZeroCoeffs, absoluteMax, nonZeroCount, bandMaxes, actualSubbands};
 }

function getSNR(data)
 {
 let setCutoff = frequencyRange == 0 ? 24000 : frequencyRange;
 let analyzeRange = freqToCoeff(setCutoff, samplingRate) + 1;
 let subbands = Math.ceil(analyzeRange / bandSize);
 let SNR = new Array(subbands * bandSize);
 let nonZeroCoeffs = new Array(subbands * bandSize);
 let bandMaxes = new Array(subbands);
 let nonZeroCount = new Array(subbands);
 let lastNonZero = 0;
 let at = 0;
 for(let i=0; i<subbands; i++)
  {
  let bandMax = -150;
  for(let j=0; j<bandSize; j++)
   {
   if(at >= analyzeRange)
    {
	SNR[at++] = 0;
	continue;
	}
   let single = data[at];
   if(single > bandMax)
    {
	bandMax = single;
	}
   SNR[at++] = single;
   }
  bandMaxes[i] = bandMax;
  if(bandMax <= 0)
   {
   continue;
   }
  at -= bandSize;
  let bandNonZero = 0;
  for(let j=0; j<bandSize; j++)
   {
   let single = SNR[at];
   let nonZero = single > 0;
   nonZeroCoeffs[at] = nonZero;
   if(nonZero && bandMax - single <= dynamicRange)
    {
	lastNonZero = at + 1;
	}
   else
    {
	SNR[at] = 0;
	}
   at++;
   if(!nonZero)
    {
	continue;
	}
   bandNonZero++;
   }
  nonZeroCount[i] = bandNonZero;
  }
 let actualSubbands = Math.ceil(lastNonZero / bandSize);
 let absoluteMax = 96;
 return {nonZeroCoeffs, nonZeroCount, bandMaxes, absoluteMax, actualSubbands};
 }

function allocate(bandMaxSMR, bandAbsoluteMax, nonZeroCoeffs, subbands)
 {
 let bitsPerBand = new Array(subbands);
 let limitedBits = new Array(subbands);
 let allocOrder = new Array(subbands);
 let sortedSMR = new Array(subbands);
 let bitLimit = 0;
 let shrink = (bitPercent / 100) * 0.98 + 0.02;
 let lowest = -1;
 for(let i=0; i<subbands; i++)
  {
  let currentSMR = bandMaxSMR[i];
  let bitCount = reqBits(currentSMR);
  bitsPerBand[i] = bitCount;
  allocOrder[i] = i;
  sortedSMR[i] = currentSMR;
  if(bitCount)
   {
   let shrinkBits = Math.ceil(bitCount * shrink);
   if(shrinkBits < 2)
	{
	shrinkBits = 2;
	}
   if(currentSMR > bandAbsoluteMax - 10)
    {
	let importantBand = nonZeroCoeffs[i] > Math.round(bandSize / 1.5);
	if(shrinkBits < 5 && currentSMR > bandAbsoluteMax - 3)
	 {
	 if(i <= lastLow)
	  {
	  shrinkBits = importantBand ? 5 : 4;
	  }
	 else
	  {
	  shrinkBits = importantBand ? 4 : 3;
	  }
	 }
	else if(shrinkBits < 3 && importantBand)
	 {
	 shrinkBits = 3;
	 }
	}
   limitedBits[i] = adaptiveAllocation ? shrinkBits : 2;//(i <= lastLow ? 2 : 1);
   bitLimit += shrinkBits * nonZeroCoeffs[i];
   if(i == 0)
	{
	lowest++;
	continue;
	}
   let shuffleTo;
   if(mostImportant == 0)
    {
    shuffleTo = -1;
    }
   else
    {
    shuffleTo = lowest;
	if(i <= lastLow)
     {
	 lowest++;
	 }
    if(currentSMR == bandAbsoluteMax)
     {
	 shuffleTo = -1;
	 if(i > lastLow)
	  {
	  lowest++;
	  }
	 }
    }
   let j = i - 1;
   while(j > shuffleTo && sortedSMR[j] < currentSMR)
    {
    sortedSMR[j + 1] = sortedSMR[j];
    allocOrder[j + 1] = allocOrder[j];
    j--;
    }
   sortedSMR[j + 1] = currentSMR;
   allocOrder[j + 1] = i;
   continue;
   }
  limitedBits[i] = 0;
  }
 bitLimit = Math.ceil(bitLimit * shrinkBudget(bitPercent));
 let prevLim = bitLimit;
 if(topBitLimit != 0 && bitLimit > topBitLimit)
  {
  bitLimit = topBitLimit;
  }
 else if(bottomBitLimit != 0 && bitLimit < bottomBitLimit)
  {
  bitLimit = (bottomBitLimit > topBitLimit && topBitLimit != 0) ? topBitLimit : bottomBitLimit;
  }
 return {limitedBits, bitsPerBand, bitLimit, allocOrder};
 }

function quantize(MDCTcoeffs, allocData, allocOrder, idealAlloc, bitLimit, nonZeroData, subbands)
 {
 let band = new Array(bandSize);
 let bandAbs = new Array(bandSize);
 let bandMaxes = new Array(subbands);
 let usedPerBand = new Array(subbands);
 let baseFreq = subbandFreq / 2;
 let chosenFactors = new Array(subbands);
 let allocated = new Array(subbands);
 let included = new Array(subbands);
 let quantized = new Array(subbands * bandSize).fill(0);
 let decoded = new Array(subbands * bandSize).fill(0);
 let at = 0;
 let usedBits = 0;
 let includedBands = 0;
 let lastSubband = -1;
 let stopAt = 0;
 let bitsEnded = false;
 for(let i=0; i<subbands; i++)
  {
  if(bitsEnded)
   {
   for(let j=stopAt+1; j<subbands; j++)
    {
	allocated[allocOrder[j]] = 0;
	}
   break;
   }
  let allocNow = allocOrder[i];
  if(allocData[allocNow] == 0)
   {
   usedPerBand[allocNow] = 0;
   included[allocNow] = 0;
   allocated[allocNow] = 0;
   continue;
   }
  includedBands++;
  at = allocNow * bandSize;
  for(let j=0; j<bandSize; j++)
   {
   if(nonZeroData[at])
    {
	bandAbs[j] = Math.abs(MDCTcoeffs[at]);
	band[j] = MDCTcoeffs[at];
    }
   else
    {
	bandAbs[j] = 0;
	band[j] = 0;
	}
   at++;
   }
  let maxVal = Math.max.apply(Math, bandAbs);
  bandMaxes[allocNow] = maxVal;
  let bandFreq = subbandFreq * allocNow + baseFreq;
  let maxDiff = maxVal * allowedError(bitPercent, bandFreq) / 100;
  let result = optimizedQuant(band, maxVal, allocData[allocNow], maxDiff);
  let arrayInd = allocNow * bandSize;
  chosenFactors[allocNow] = result.factor;
  allocated[allocNow] = result.precision;
  for(let j=0; j<bandSize; j++)
   {
   quantized[arrayInd] = result.values[j];
   decoded[arrayInd++] = result.reconstructed[j];
   }
  usedBits += result.used;
  usedPerBand[allocNow] = result.used;
  included[allocNow] = result.notZeroed;
  if(allocNow > lastSubband)
   {
   lastSubband = allocNow;
   }
  if(usedBits > bitLimit)
   {
   stopAt = i;
   bitsEnded = true;
   }
  }
 let remain = bitLimit - usedBits;
 if(remain < 0)
  {
  remain = 0;
  }
 let distribute = remain + savedBits;
 if(distribute <= 0)
  {
  includedBands = 0;
  }
 for(let i=0; i<includedBands; i++)
  {
  if(distribute <= 0 && i > 1)
   {
   distribute = 0;
   break;
   }
  let refineNow = allocOrder[i];
  let offset = bandSize * refineNow;
  for(let j=0; j<bandSize; j++)
   {
   let ind = offset + j;
   if(nonZeroData[ind])
    {
	band[j] = MDCTcoeffs[ind];
	continue;
	}
   band[j] = 0;
   }
  let bandFreq = subbandFreq * refineNow + baseFreq;
  let maxDiff = bandMaxes[refineNow] * allowedError(bitPercent, bandFreq) / 100;
  let result = optimizedQuant(band, bandMaxes[refineNow], idealAlloc[refineNow], maxDiff);
  let arrayInd = refineNow * bandSize;
  chosenFactors[refineNow] = result.factor;
  allocated[refineNow] = result.precision;
  included[refineNow] = result.notZeroed;
  for(let j=0; j<bandSize; j++)
   {
   quantized[arrayInd] = result.values[j];
   decoded[arrayInd++] = result.reconstructed[j];
   }
  let addedBits = result.used - usedPerBand[refineNow];
  usedBits += addedBits;
  distribute -= addedBits;
  }
 savedBits = distribute;
 subbands = lastSubband + 1;
 return {quantized, decoded, allocated, chosenFactors, included, subbands};
 }

function optimizedQuant(MDCTband, bandMax, maxBits, allowedError)
 {
 let quantized = new Array(bandSize);
 let decoded = new Array(bandSize);
 let usedBits = 0;
 let includedCoeffs = 0;
 for(let i=2; i<=maxBits; i++)
  {
  let maxStorable = (1 << (i - 1));
  let scaleBy = bandMax / maxStorable;
  let idealFactor = 1 / scaleBy;
  let tableIndex = Math.floor(Math.log10(idealFactor / 20000) / -0.2041199826559248);
  if(tableIndex < 0)
   {
   tableIndex = 0;
   }
  else if(tableIndex > 63)
   {
   tableIndex = 63;
   }
  let scf = scaleFactors[tableIndex];
  if(Math.round(bandMax * scf) > maxStorable && tableIndex < 63)
   {
   tableIndex++;
   scf = scaleFactors[tableIndex];
   }
  let invScf = scaleFactorsInv[tableIndex];
  let passed = true;
  let maxErr = 0;
  usedBits = 0;
  includedCoeffs = 0;
  for(let j=0; j<bandSize; j++)
   {
   let single = MDCTband[j];
   if(single == 0)
    {
	quantized[j] = 0;
	decoded[j] = 0;
	continue;
	}
   let scaled = Math.round(single * scf);
   let reconstruct = scaled * invScf;
   let error = Math.abs(reconstruct - single);
   quantized[j] = scaled;
   decoded[j] = reconstruct;
   if(scaled != 0)
    {
	usedBits += i;
    includedCoeffs++;
	}
   if(error > allowedError)
    {
	passed = false;
	if(error > maxErr)
	 {
	 maxErr = error;
	 }
	if(i < maxBits)
	 {
	 break;
	 }
	}
   }
  if(passed || i == maxBits)
   {
   return {values: quantized, reconstructed: decoded, precision: i, used: usedBits, notZeroed: includedCoeffs, factor: tableIndex};
   }
  }
 }

function add_dB(values, count)
 {
 let total = 0;
 for(let i=0; i<count; i++)
  {
  total += Math.pow(10, values[i] / 10);
  }
 return 10 * Math.log10(total);
 }

function nonMaskSize(magnitude, tonal)
 {
 for(let i=0; i<4; i++)
  {
  if(magnitude >= regionSteps[i])
   {
   return tonal ? regionSizesTonal[i] : regionSizesNoise[i];
   }
  }
 return 0;
 }

function coeffToBark(coeff, rate)
 {
 let frq = ((coeff + 1) / 1024) * rate;
 let result = Bark(frq);
 return result > 26 ? 26 : result;
 }
 
function barkToCoeff(bark, rate)
 {
 let fr = Freq(bark);
 if(fr > rate / 2)
  {
  fr = rate / 2;
  }
 let result = Math.round((fr * 1024) / rate - 1);
 if(result < 0)
  {
  result = 0;
  }
 else if(result > 511)
  {
  result = 511;
  }
 return result;
 }

function freqToCoeff(frq, rate)
 {
 let res = Math.round((frq * 1024) / rate - 1);
 return res > 511 ? 511 : res;
 }

function coeffToFreq(coeff, rate)
 {
 return (coeff + 1) / 1024 * rate;
 }

function hearingThreshold(coeff, rate)
 {
 let find = coeffToFreq(coeff, rate);
 if(find < 50)
  {
  return thresholds[0];
  }
 let ind = parseInt((find - 50) / 60 + 1);
 return ind > 335 ? thresholds[335] : thresholds[ind];
 }`;