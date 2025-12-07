/*
    DAC - Dynamic Audio Codec, a lossy audio codec written by MINT: https://www.youtube.com/@__MINT_
    
    This file contains bitstream formatting functions for DAC, comes with absolutely no warranty!
*/

const encoderString = `

let audioBuffer;
let channelSamples = 0;
let audioChannels = 0;
let dataWidth = 0;
let originalSize = 0;
let receivedMeta = [];
let addMeta = false;

self.onmessage = function(event)
 {
 let input = event.data;
 switch(input.type)
  {
  case "config":
   {
   let params = input.values;
   bitPercent = params.quality;
   samplingRate = params.rate;
   dataWidth = params.bitDepth;
   audioChannels = params.channels;
   dynamicRange = params.dynaRange;
   frequencyRange = params.freqRange;
   topBitLimit = params.upBitLim;
   bottomBitLimit = params.loBitLim;
   mostImportant = params.lowFreqRange;
   transientThreshold = params.transientSens;
   bandSize = params.subbandSize;
   keyframeGap = params.keyframeInt;
   adaptiveAllocation = params.adaptAlloc;
   originalSize = params.origSize;
   highStart = freqToCoeff(4000, samplingRate);
   highStop = freqToCoeff(20000, samplingRate);
   noiseFloor = noiseFloors[dataWidth];
   subbandFreq = samplingRate / 1024 * bandSize;
   lastLow = Math.floor(mostImportant / subbandFreq);
   regionSteps = [
	Math.round(dynamicRange * 0.84375),
	Math.round(dynamicRange * 0.73958),
	Math.round(dynamicRange * 0.63542),
	Math.round(dynamicRange * 0.47917)
	];
   receivedMeta = params.fileMetaData;
   addMeta = params.includeMeta;
   postMessage({type: "received"});
   }
  break;
  case "audio":
   {
   audioBuffer = new Int32Array(input.audio);
   channelSamples = input.chSamples;
   postMessage({type: "received"});
   }
  break;
  case "encode":
   {
   Encode(bitPercent);
   }
  break;
  case "slice":
   {
   let startTime = input.startFrom;
   let sliceDur = input.fragment;
   sliceAudio(startTime, sliceDur);
   }
  break;
  case "stop":
   {
   postMessage({type: "stopped", audio: audioBuffer}, [audioBuffer.buffer]);
   self.close();
   }
  break;
  }	 
 }


function Encode(quality)
 {
 let encoded = new Uint8Array(originalSize);
 let preview = new Uint8Array(originalSize);
 savedBits = 0;
 let frames = (channelSamples >> 9) - 1;
 if(frames < 1)
  {
  abortProcess("Error: too short file.");
  return;
  }
 let upperLim = tops[dataWidth];
 let bottomLim = bottoms[dataWidth];
 let setCutoff = frequencyRange == 0 ? cutoff(bitPercent) : frequencyRange;
 let usedBands = Math.ceil((freqToCoeff(setCutoff, samplingRate) + 1) / bandSize);
 let framesPerSecond = samplingRate / 512;
 let frameGroupSize = Math.round(framesPerSecond / 4); // send bitrate info every ~250ms
 let groupMult = framesPerSecond / frameGroupSize * 8;
 let includedFrames = 0;
 let keyFrameInterval = Math.round(framesPerSecond * keyframeGap);
 let keyFramesCount = Math.floor((frames - 1) / (keyFrameInterval + 1)) + 1;
 let headerData = createHeader(keyFramesCount, keyFrameInterval, frames);
 let keyAllocPointer = headerData.headLen;  // pointer to key frame location data
 for(let i=4; i<keyAllocPointer; i++)
  {
  encoded[i] = headerData.created[i];
  }
 let startBytePointer = headerData.size;  // first free byte for frame storage
 let startByteOffset = 0;   // first free bit in that byte
 let allocData = [];
 let factorData = [];
 let transients = new Array(audioChannels).fill(false);
 let prevHighTones = new Array(audioChannels).fill(noiseFloor);
 let bitStream = [];
 let lenData = [];
 let subbandPointers = [];  // key frame subband locations
 let previewPointer = 44;  // pointer to first free byte in preview array
 let overlapAdd = [];
 let prevSize = startBytePointer;
 for(let i=0; i<audioChannels; i++)  // prepare arrays for each channel
  {
  allocData.push(new Array(usedBands));
  factorData.push(new Array(usedBands));
  subbandPointers.push(new Array(usedBands));
  overlapAdd.push([new Array(512), new Array(1024)]);
  }
 let normalCount = keyFrameInterval;  // first frames are key frames
 let percentBef = 1;
 for(let i=0; i<frames; i++)
  {
  let percentNow = Math.round(i / frames * 100);
  if(percentNow != percentBef)
   {
   postMessage({type: "progress", value: percentNow});
   percentBef = percentNow;
   }
  if(normalCount == keyFrameInterval)
   {
   for(let j=0; j<audioChannels; j++)
    {
    let keyFrame = createFrame(i, j, prevHighTones[j], transients[j]);  // get frame i for channel j
	
	transients[j] = keyFrame.transient;
	prevHighTones[j] = keyFrame.high;
	let singleAlloc = keyFrame.allocated;
    let singleFactor = keyFrame.chosenFactors;
    let frameBands = keyFrame.subbands;
    let quantizedFrame = keyFrame.quantized;
    let coefficients = frameBands * bandSize;
	let decodedAudio = FIMDCT(keyFrame.decoded, coefficients);
	if(i == 0)
	 {
	 overlapAdd[j][0] = decodedAudio.slice(0, 512);
	 }
	else
	 {
	 overlapAdd[j][0] = overlapAdd[j][1].slice(512, 1024);
	 }
	overlapAdd[j][1] = decodedAudio;
	let bitLen = 8;
    bitStream = [];
    lenData = [];
	if(j == 0)  // store only first channel key frames location
	 {
	 if(startByteOffset)  // adjust to byte boundary
	  {
	  startBytePointer++;
	  startByteOffset = 0;
	  }
	 let frameLoc = binConvert(startBytePointer, 4);
     for(let k=0; k<4; k++)
      {
      encoded[keyAllocPointer++] = frameLoc[k];  // store key frame location in file header
      }
     }
	bitStream.push(usedBands | 128); // first bit is set only for key frames; full possible frame range must be included to be updatable later
    lenData.push(8);
	for(let k=0; k<usedBands; k++)
     {
     if(k >= frameBands)
      {
	  bitStream.push(0);
	  bitStream.push(0);
	  bitStream.push(0);
	  lenData.push(1);
      bitLen++;
      let bytesForward = (bitLen + startByteOffset) >> 3;
	  let bitAt = (bitLen + startByteOffset) & 7;
	  subbandPointers[j][k] = ((startBytePointer + bytesForward) << 3) + bitAt; // pointer to first bit of allocation data
	  lenData.push(4);
      lenData.push(6);
      bitLen += 10;
	  allocData[j][k] = 255;
	  continue;
	  }
     let precision = singleAlloc[k];
     let inUse = precision != 0;
     if(inUse)
      {
	  bitStream.push(1); // empty or full bit
	  bitStream.push(precision - 1);  // bit allocation data
	  bitStream.push(singleFactor[k]);  // scalefactor data
	  allocData[j][k] = precision;
	  factorData[j][k] = singleFactor[k];
	  }
     else
      {
	  bitStream.push(0);
	  bitStream.push(0);
	  bitStream.push(0);
	  allocData[j][k] = 255;
	  }
     lenData.push(1);
	 bitLen++;
     let bytesForward = (bitLen + startByteOffset) >> 3;
	 let bitAt = (bitLen + startByteOffset) & 7;
	 subbandPointers[j][k] = ((startBytePointer + bytesForward) << 3) + bitAt; // pointer to first bit of allocation data
	 lenData.push(4);
     lenData.push(6);
     bitLen += 10;
     if(!inUse)
      {
	  continue;
	  }
     let quantOffset = k * bandSize;
     for(let l=0; l<bandSize; l++)
      {
	  let single = quantizedFrame[quantOffset++];
	  if(single == 0)  // zeroed coefficient
	   {
	   bitStream.push(0);  // single bit is used
	   lenData.push(1);
	   bitLen++;
	   continue;
	   }
	  bitStream.push(1);  // non-zero bit set
	  lenData.push(1);
	  if(single < 0)
	   {
	   single = -single;
	   bitStream.push(1);  // sign bit set
	   }
	  else
	   {
	   bitStream.push(0);
	   }
	  lenData.push(1);
	  bitStream.push(single - 1);  // stored values are decremented by 1, 1 is stored as 0, 2 as 1, etc.
	  lenData.push(precision - 1);  // remove sign bit from allocation data
	  bitLen += precision + 1;
	  }
     }
    let usedBytes = Math.ceil((bitLen + startByteOffset) / 8);  // bytes generated by byteFormat()
    let formattedFrame = byteFormat(bitStream, lenData, usedBytes, startByteOffset);
    for(let k=0; k<usedBytes; k++)
     {
     if(k == 0 && startByteOffset)
	  {
	  encoded[startBytePointer++] |= formattedFrame[0];  // fill remaining bits
	  continue;
	  }
	 encoded[startBytePointer++] = formattedFrame[k];
	 }
	startByteOffset = (bitLen + startByteOffset) & 7;
	if(startByteOffset){startBytePointer--;}
	}
   normalCount = 0;
   }
  else
   {
   for(let j=0; j<audioChannels; j++)
    {
	let normalFrame = createFrame(i, j, prevHighTones[j], transients[j]);  // get frame i for channel j
	transients[j] = normalFrame.transient;
	prevHighTones[j] = normalFrame.high;
    let singleAlloc = normalFrame.allocated;
    let singleFactor = normalFrame.chosenFactors;
    let frameBands = normalFrame.subbands;
    let quantizedFrame = normalFrame.quantized;
	let coefficients = frameBands * bandSize;
	let decodedAudio = FIMDCT(normalFrame.decoded, coefficients);
	overlapAdd[j][0] = overlapAdd[j][1].slice(512, 1024);
	overlapAdd[j][1] = decodedAudio;  // store decoded audio for further processing
	let allocDiff = [];  // allocation differences
	let factorDiff = [];  // scalefactor differences
	let isEmpty = [];  // empty subband information
	let lastEmpty = -1;
	let emptyCount = 0;
	let maxEmpty = 0;
    let maxAllocDiff = 0;
	let maxFactorDiff = 0;
	let nonZeroAlloc = 0;
	let nonZeroFactor = 0;
	for(let k=0; k<frameBands; k++)
	 {
	 if(singleAlloc[k] == 0)  // unused subband
	  {
	  allocDiff.push(0);
	  factorDiff.push(0);
	  emptyCount++;
	  if(lastEmpty == -1)
	   {
	   isEmpty.push(1);
	   lastEmpty = k;
	   continue;
	   }
	  let counted = isEmpty[lastEmpty] + 1;
	  if(counted > maxEmpty)
	   {
	   maxEmpty = counted;
	   }
	  isEmpty[lastEmpty] = counted;
	  isEmpty.push(1);
	  continue;
	  }
	 isEmpty.push(0);
	 lastEmpty = -1;
	 if(allocData[j][k] == 255)  // update key frame absolute data
	  {
	  allocDiff.push(0);  // no difference in reference to updated data
	  factorDiff.push(0);
	  let updateByte = subbandPointers[j][k] >> 3;
	  let startBit = subbandPointers[j][k] - (updateByte << 3);
	  let change = Math.ceil((startBit + 10) / 8); // Math.ceil(x >> 8) != Math.ceil(x / 8), idiot!
	  let modify = encoded.slice(updateByte, updateByte + change);
	  let subbandData = (((singleAlloc[k] - 1) << 6) | singleFactor[k]) & 1023;
	  modify = insert(modify, subbandData, 10, change, startBit);
	  for(let l=0; l<change; l++)
	   {
	   encoded[updateByte + l] = modify[l];  // update file header
	   }
	  allocData[j][k] = singleAlloc[k];  // update reference arrays
	  factorData[j][k] = singleFactor[k];
	  continue;
	  }
	 let singleAllocDiff = singleAlloc[k] - allocData[j][k];
	 let singleFactorDiff = singleFactor[k] - factorData[j][k];
	 nonZeroAlloc += singleAllocDiff != 0;
	 nonZeroFactor += singleFactorDiff != 0;
	 let allocAbs = Math.abs(singleAllocDiff);
	 let factorAbs = Math.abs(singleFactorDiff);
	 if(allocAbs > maxAllocDiff)
	  {
	  maxAllocDiff = allocAbs;
	  }
	 if(factorAbs > maxFactorDiff)
	  {
	  maxFactorDiff = factorAbs;
	  }
	 allocDiff.push(singleAllocDiff);
	 factorDiff.push(singleFactorDiff);
	 allocData[j][k] = singleAlloc[k];
	 factorData[j][k] = singleFactor[k];
	 }
	let allocBits = 0;
	let factorBits = 0;
	let nonZeroBits = 0;
	if(maxAllocDiff != 0)
	 {
	 while(1 << allocBits <= maxAllocDiff)
	  {
	  allocBits++;
	  }
	 allocBits++;
	 nonZeroBits++;
	 }
	if(maxFactorDiff != 0)
	 {
	 while(1 << factorBits < maxFactorDiff)
	  {
	  factorBits++;
	  }
	 factorBits++;
	 nonZeroBits++;
	 }
	let bandsInUse = frameBands - emptyCount;
	let handleEmpty = 0;
	if(emptyCount)  // decide, how to handle empty subbands
	 {
	 let allocForNonEmpty = allocBits;
	 if(allocBits > 1)
	  {
	  allocForNonEmpty = 1 << (allocBits - 2) >= maxAllocDiff ? allocBits - 1 : allocBits; // maximum value in alloc field is allowed with non-empty bits
	  }
	 let differentialBits = nonZeroFactor * factorBits;
	 let differentialBitsNonEmpty = differentialBits + nonZeroAlloc * allocForNonEmpty;
	 differentialBits += nonZeroAlloc * allocBits;
	 let bitsWithNonZero = frameBands + bandsInUse * (nonZeroBits + bandSize) + differentialBitsNonEmpty;
	 let bitsEmptyIncluded = frameBands * (nonZeroBits + bandSize) + differentialBits; // empty bands are treated as full
	 let adjAllocBits;
	 if(allocBits == 0)  // if there is no allocation data, add sign bit & value bit
	  {
	  adjAllocBits = 2;
	  }
	 else
	  {
	  adjAllocBits = (1 << (allocBits - 1)) >= maxAllocDiff + 1 ? allocBits : allocBits + 1;  // adjust number of bits to mark empty subbands
	  }
	 let bitsEmptyMarked = bandsInUse * ((factorBits != 0) + bandSize + 1) + nonZeroAlloc * adjAllocBits + nonZeroFactor * factorBits + emptyCount * (adjAllocBits + 1);  // empty subbands are marked using bit allocation field
	 let bitsEmptyGrouped = bitsEmptyIncluded + 1;
	 let adjFactorBits = factorBits == 0 ? 1 : factorBits;
	 while(1 << adjFactorBits <= maxEmpty - 2) // increase factor bit budget so that empty subband group size fits
	  {
	  adjFactorBits++;
	  }
	 if(maxEmpty > 1)
	  {
	  bitsEmptyGrouped = nonZeroAlloc * adjAllocBits + nonZeroFactor * adjFactorBits + (bandSize + 2) * bandsInUse;  // calculate for bands in use
	  for(let k=0; k<frameBands; k++)  // iterate through empty subbands
	   {
	   let subbandData = isEmpty[k];
	   if(subbandData == 0) // band in use
	    {
		continue;
		}
	   if(subbandData == 1) // marking single subband
	    {
		bitsEmptyGrouped += adjAllocBits + 1;
		continue;
		}
	   bitsEmptyGrouped += adjAllocBits + adjFactorBits + 2; // marking empty group
	   k += subbandData - 1;
	   }
	  }
	 let dataGrouped = [bitsEmptyIncluded, bitsWithNonZero, bitsEmptyGrouped, bitsEmptyMarked];
	 let numbered = [0, 1, 3, 2];
	 let chooseMin = new Array(4);
	 let methodNumbers = new Array(4);
	 for(let k=0; k<4; k++)
	  {
	  chooseMin[k] = dataGrouped[k];
	  methodNumbers[k] = numbered[k];
	  if(k == 0)
	   {
	   continue;
	   }
	  let l = k - 1;
	  while(l >= 0 && dataGrouped[k] < chooseMin[l])
	   {
	   chooseMin[l + 1] = chooseMin[l];
	   methodNumbers[l + 1] = methodNumbers[l];
	   l--;
	   }
	  chooseMin[l + 1] = dataGrouped[k];
	  methodNumbers[l + 1] = numbered[k];
	  }
	 handleEmpty = methodNumbers[0];
	 switch(handleEmpty)
	  {
	  case 1:
	   {
	   allocBits = allocForNonEmpty;
	   }
	  break;
	  case 2:
	   {
	   allocBits = adjAllocBits;
	   }
	  break;
	  case 3:
	   {
	   allocBits = adjAllocBits;
	   factorBits = adjFactorBits;
	   }
	  break;
	  }
	 }
	let bitLen = 15;
	bitStream = [];
    lenData = [];
	bitStream.push(frameBands); // number of subbands
	handleEmpty == 1 ? bitStream.push(1) : bitStream.push(0); // information whether non-empty bits are used
	bitStream.push(allocBits);  // allocation data precision
	bitStream.push(factorBits); // scalefactor data precision
	lenData.push(8);
	lenData.push(1);
	lenData.push(3);
	lenData.push(3);
	for(let k=0; k<frameBands; k++)  // encode frame after analysis
	 {
	 let emptyData = isEmpty[k];
	 if(handleEmpty == 1)
	  {
	  lenData.push(1);
	  bitLen++;
	  if(emptyData)
	   {
	   bitStream.push(0);  // non-empty bit cleared
	   continue;
	   }
	  bitStream.push(1);  // non-empty bit set
	  }
	 if(emptyData)
	  {
	  switch(handleEmpty) // empty subband handling
	   {
	   case 0:  // just include them
	    {
	    if(nonZeroBits)  // differential data non-zero bits
		 {
		 bitStream.push(0);
		 lenData.push(nonZeroBits);
		 bitLen += nonZeroBits;
		 }
		let zeroCount = bandSize;
		while(zeroCount > 0)
		 {
		 zeroCount -= 16;  // byteFromat() accepts at most 16 bits per value
		 let added = 16;
		 if(zeroCount < 0)
		  {
		  added += zeroCount;
		  zeroCount = 0;
		  }
		 bitStream.push(0);
		 lenData.push(added);  // zeroed coefficients
		 }
		bitLen += bandSize;
		}
	   break;
	   case 2:  // mark single empty subbands
	    {
	    let maxAllocVal = 1 << (allocBits - 1);  // maximum value marks empty subband without additional bits
		bitStream.push(1);  // non-zero bit set
		bitStream.push(0);  // sign bit cleared
		bitStream.push(maxAllocVal - 1);  // decrement stored value (0 means 1)
		lenData.push(1);
		lenData.push(1);
		lenData.push(allocBits - 1);
		bitLen += allocBits + 1;
	    }
	   break;
	   case 3:
	    {
	    let maxAllocVal = 1 << (allocBits - 1);  // maximum value marks empty subband without additional bits
		bitStream.push(1);  // non-zero bit set
		emptyData == 1 ? bitStream.push(0) : bitStream.push(1);  // sign bit denotes single band or group
		bitStream.push(maxAllocVal - 1);  // decrement stored value (0 means 1)
		lenData.push(1);
		lenData.push(1);
		lenData.push(allocBits - 1);
		bitLen += allocBits + 1;
		if(emptyData == 1)  // single band was already marked
		 {
		 continue;
		 }
		bitStream.push(emptyData - 2);  // store empty group size
		lenData.push(factorBits + 1);   // non-zero bit & sign bit are used to store a value
		bitLen += factorBits + 1;
		k += emptyData - 1;  // don't forget to jump over empty bands
		}
	   break;
	   }
	  continue;
	  }
	 if(allocBits != 0)  // differential allocation data included
	  {
	  let singleDiff = allocDiff[k];
	  if(singleDiff == 0)  // no difference, non-zero bit = 0
	   {
	   bitStream.push(0);
	   lenData.push(1);
	   bitLen++;
	   }
	  else
	   {
	   bitStream.push(1);  // difference included
	   lenData.push(1);
	   if(singleDiff < 0)  // negative, set sign bit
	    {
		singleDiff = -singleDiff;
		bitStream.push(1);
		}
	   else
	    {
		bitStream.push(0);  // positive
		}
	   lenData.push(1);
	   let remain = allocBits - 1;  // differential data bits left
	   if(remain > 0)
	    {
		bitStream.push(singleDiff - 1);
		lenData.push(remain);
		}
	   bitLen += remain + 2;
	   }
	  }
	 if(factorBits != 0)  // differential scalefactor data included
	  {
	  let singleDiff = factorDiff[k];
	  if(singleDiff == 0)  // no difference, non-zero bit = 0
	   {
	   bitStream.push(0);
	   lenData.push(1);
	   bitLen++;
	   }
	  else
	   {
	   bitStream.push(1);  // difference included
	   lenData.push(1);
	   if(singleDiff < 0)  // negative, set sign bit
	    {
		singleDiff = -singleDiff;
		bitStream.push(1);
		}
	   else
	    {
		bitStream.push(0);  // positive
		}
	   lenData.push(1);
	   let remain = factorBits - 1;  // differential data bits left
	   if(remain > 0)
	    {
		bitStream.push(singleDiff - 1);
		lenData.push(remain);
		}
	   bitLen += remain + 2;
	   }
	  }
	 let quantOffset = k * bandSize;
     for(let l=0; l<bandSize; l++)
      {
	  let single = quantizedFrame[quantOffset++];
	  if(single == 0)  // zeroed coefficient
	   {
	   bitStream.push(0);  // single bit is used
	   lenData.push(1);
	   bitLen++;
	   continue;
	   }
	  bitStream.push(1);  // non-zero bit set
	  lenData.push(1);
	  if(single < 0)
	   {
	   single = -single;
	   bitStream.push(1);  // sign bit set
	   }
	  else
	   {
	   bitStream.push(0);
	   }
	  let precision = singleAlloc[k];
	  lenData.push(1);
	  bitStream.push(single - 1);  // stored values are decremented by 1, 1 is stored as 0, 2 as 1, etc.
	  lenData.push(precision - 1);  // remove sign bit from allocation data
	  bitLen += precision + 1;  // include sign bit & non-zero bit
	  }
	 }
	let usedBytes = Math.ceil((bitLen + startByteOffset) / 8);  // bytes generated by byteFormat()
	let formattedFrame = byteFormat(bitStream, lenData, usedBytes, startByteOffset);
	for(let k=0; k<usedBytes; k++)
     {
     if(k == 0 && startByteOffset)
	  {
	  encoded[startBytePointer++] |= formattedFrame[0];  // fill remaining bits
	  continue;
	  }
	 encoded[startBytePointer++] = formattedFrame[k];
     }
	startByteOffset = (bitLen + startByteOffset) & 7;
	if(startByteOffset){startBytePointer--;}
	}
   normalCount++;
   }
  if(startBytePointer > originalSize)
   {
   abortProcess("Error: data overflow.");
   return;
   }
  includedFrames++;
  if(includedFrames >= frameGroupSize)
   {
   includedFrames = 0;
   let increasedBy = startBytePointer - prevSize;
   let estimatedBitrate = increasedBy * groupMult;
   prevSize = startBytePointer;
   postMessage({type: "bitrate", value: estimatedBitrate});
   }
  if(i == 0)
   {
   for(let j=0; j<512; j++)
	{
	for(let k=0; k<audioChannels; k++)
	 {
	 let single = overlapAdd[k][0][j];
	 if(single > upperLim)
	  {
	  single = upperLim;
	  }
	 else if(single < bottomLim)
	  {
	  single = bottomLim;
	  }
	 let bytes = binConvert(single, dataWidth);
	 for(let val of bytes)
	  {
	  preview[previewPointer++] = val;
	  }
	 }
	}
   continue;
   }
  for(let j=0; j<512; j++)
   {
   for(let k=0; k<audioChannels; k++)
	{
	let single = overlapAdd[k][0][j] + overlapAdd[k][1][j];
	if(single > upperLim)
	 {
	 single = upperLim;
	 }
	else if(single < bottomLim)
	 {
	 single = bottomLim;
	 }
	let bytes = binConvert(single, dataWidth);
	for(let val of bytes)
	 {
	 preview[previewPointer++] = val;
	 }
	}
   }
  }
 let remaining = originalSize - previewPointer;
 let addByte = dataWidth == 1 ? 127 : 0;
 for(let i=0; i<remaining; i++)
  {
  preview[previewPointer++] = addByte;
  }
 const header = [82, 73, 70, 70, 87, 65, 86, 69, 102, 109, 116, 32, 100, 97, 116, 97];
 const indexes = [0, 1, 2, 3, 8, 9, 10, 11, 12, 13, 14, 15, 36, 37, 38, 39];
 let readPointer = 0;
 for(let i of indexes)
  {
  preview[i] = header[readPointer++];
  }
 let previewSize = binConvert(previewPointer - 8, 4);
 for(let i=0; i<4; i++)
  {
  preview[i + 4] = previewSize[i];
  }
 preview[16] = 16;
 preview[20] = 1;
 preview[22] = audioChannels;
 preview[23] = audioChannels >> 8;
 let rateInfo = binConvert(samplingRate, 4);
 for(let i=0; i<4; i++)
  {
  preview[i + 24] = rateInfo[i];
  }
 let dataVerify1 = binConvert(samplingRate * audioChannels * dataWidth, 4);
 for(let i=0; i<4; i++)
  {
  preview[i + 28] = dataVerify1[i];
  }
 let dataVerify2 = binConvert(audioChannels * dataWidth, 2);
 preview[32] = dataVerify2[0];
 preview[33] = dataVerify2[1];
 preview[34] = dataWidth << 3;
 let audioSection = binConvert(previewPointer - 44, 4);
 for(let i=0; i<4; i++)
  {
  preview[i + 40] = audioSection[i];
  }
 let totalSize = startByteOffset ? startBytePointer + 1 : startBytePointer;
 let store = binConvert(totalSize, 4);
 for(let i=0; i<4; i++)
  {
  encoded[i] = store[i];  // store file size information
  }
 let duration = (frames + 1) * 512 / samplingRate;
 let compressionRatio = (originalSize / totalSize).toFixed(2);
 let avgBitrate = (totalSize / duration * 0.008).toFixed(2);
 let trimmedFile = encoded.slice(0, totalSize);
 postMessage({type: "terminated", audio: audioBuffer.buffer, compressed: trimmedFile.buffer, wavePreview: preview.buffer, bitrate: avgBitrate, ratio: compressionRatio, size: totalSize}, [audioBuffer.buffer, trimmedFile.buffer, preview.buffer]);
 self.close();
 }

function sliceAudio(startTime, fragDur)
 {
 let totalFrames = (channelSamples >> 9) - 1;
 if(totalFrames < 1)
  {
  abortProcess("Error: too short file.");
  return;
  }
 let upperLim = tops[dataWidth];
 let bottomLim = bottoms[dataWidth];
 let normFactor = normalizeFactors[dataWidth];
 let firstSample = Math.round(startTime * samplingRate);
 let lastSample = Math.round((startTime + fragDur) * samplingRate);
 let totalSamples = lastSample - firstSample;
 let startFrame = Math.floor(firstSample / 512 - 1);
 let endFrame = Math.floor(lastSample / 512);
 let startOffset = firstSample & 511;
 let endOffset = lastSample & 511;
 let endTime = lastSample / samplingRate;
 let actualDur = totalSamples / samplingRate;
 let usedChannels = audioChannels > 1 ? 2 : 1;
 let transients = [false, false];
 let prevHighTones = [-1, -1];
 let overlapAdd = [[new Array(512), new Array(1024)], [new Array(512), new Array(1024)]];
 let slicedSamples = [new Float32Array(totalSamples), new Float32Array(totalSamples)];
 let slicePointers = [0, 0];
 let estimatedSize = 0;
 if(startFrame < 0)
  {
  startFrame = 0;
  }
 let readSamples = (endFrame - startFrame + 1) * 512;
 for(let i=startFrame; i<=endFrame; i++)
  {
  for(let j=0; j<usedChannels; j++)
   {
   let created = createFrame(i, j, prevHighTones[j], transients[j]);
   prevHighTones[j] = created.high;
   transients[j] = created.transient;
   let frameSize = 15 + created.subbands; // header + non-empty bits
   for(let k=0; k<created.subbands; k++)
    {
	let precision = created.allocated[k];
	if(precision == 0)
	 {
	 continue;
	 }
	frameSize += 3 + bandSize; // non-zero bits & estimated differential alloc bits
	frameSize += created.included[k] * precision; // coefficients
	}
   estimatedSize += frameSize;
   let rawAudio = FIMDCT(created.decoded, created.subbands * bandSize);
   if(i == startFrame)
	{
	overlapAdd[j][0] = rawAudio.slice(0, 512);
	overlapAdd[j][1] = rawAudio;
	continue;
	}
   overlapAdd[j][0] = overlapAdd[j][1].slice(512, 1024);
   overlapAdd[j][1] = rawAudio;
   for(let k=0; k<512; k++)
	{
	if(i == endFrame && k >= endOffset)
	 {
	 break;
	 }
	if(i == startFrame + 1 && k < startOffset)
	 {
	 continue;
	 }
	let normalized = overlapAdd[j][0][k] + overlapAdd[j][1][k];
	if(normalized > upperLim)
	 {
	 normalized = upperLim;
	 }
	else if(normalized < bottomLim)
	 {
	 normalized = bottomLim;
	 }
	if(dataWidth == 1){normalized -= 128;}
	normalized /= normFactor;
	slicedSamples[j][slicePointers[j]++] = normalized;
	}
   }
  }
 let estimatedBitrate = estimatedSize * (samplingRate / readSamples);
 if(usedChannels == 2)
  {
  postMessage({type: "success", audioL: slicedSamples[0], audioR: slicedSamples[1], sampleLen: slicePointers[0], endStamp: endTime, duration: actualDur, avgBitrate: estimatedBitrate}, [slicedSamples[0].buffer, slicedSamples[1].buffer]);
  return;
  }
 postMessage({type: "success", audioL: slicedSamples[0], sampleLen: slicePointers[0], endStamp: endTime, duration: actualDur, avgBitrate: estimatedBitrate}, [slicedSamples[0].buffer]);
 }

function abortProcess(messageText)
 {
 postMessage({type: "error", desc: messageText, audio: audioBuffer.buffer}, [audioBuffer.buffer]);
 self.close();
 }

function createHeader(keyFrameCount, keyFrameSpacing, frameCount)
 {
 let samplingData = samplingRate;
 let totalKeyFrames = keyFrameCount;
 let header = new Array(21).fill(0);
 let headerPointer = 4;
 for(let i=0; i<4; i++)
  {
  header[headerPointer++] = frameCount & 255;  // number of frames per channel
  frameCount >>= 8;
  }
 header[headerPointer++] = dataWidth & 255;  // data width
 header[headerPointer++] = bandSize & 255;  // subband size
 header[headerPointer++] = (audioChannels - 1) & 255;  // number of channels - 1
 for(let i=0; i<3; i++)
  {
  header[headerPointer++] = samplingData & 255;  // sampling rate
  samplingData >>= 8;
  }
 for(let i=0; i<3; i++)
  {
  header[headerPointer++] = keyFrameCount & 255;  // number of key frames per channel
  keyFrameCount >>= 8;
  }
 header[headerPointer++] = keyFrameSpacing & 255;  // key frame spacing
 header[headerPointer++] = (keyFrameSpacing >> 8) & 255;
 headerPointer += 2;  // space for metadata end pointer
 if(addMeta)
  {
  const prefixes = ["TI", "AR", "AL", "GE", "YE", "TR"];
  for(let i=0; i<6; i++)
   {
   let single = receivedMeta[i];
   let characters = single.length;
   if(characters > 0)
    {
	if(characters > 254)
	 {
	 characters = 254;
	 }
	header.push(prefixes[i].charCodeAt(0));
	header.push(prefixes[i].charCodeAt(1));
	header.push(characters + 1);
	headerPointer += 3;
	for(let j=0; j<characters; j++)
	 {
	 let code = single.charCodeAt(j);
	 header.push(code & 255);
	 header.push((code >> 8) & 255);
	 headerPointer += 2;
	 }
	header.push(0);
	header.push(0);
	headerPointer += 2;
	}
   }
  header[19] = headerPointer & 255;
  header[20] = (headerPointer >> 8) & 255;
  }
 let headerBytes = headerPointer + totalKeyFrames * 4;
 let packed = new Uint8Array(header);
 return {created: packed, size: headerBytes, headLen: headerPointer};
 }`;